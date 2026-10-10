//! Loading a CSV file into a table with `COPY ... FROM STDIN`.
//!
//! The file streams to the server, so its size is no limit. When every
//! column of the file goes to a column of the table, the bytes are sent
//! as they are and the server's own CSV reader does the parsing. When some
//! are skipped, a parser thread picks the wanted fields and writes them in
//! a fixed form the server reads back exactly. Either way it is one `COPY`
//! statement, which the server applies completely or not at all.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::mpsc;

use crate::commands::{forget_task, session, track_task};
use crate::error::{AppError, AppResult};
use crate::logging::{self, logged, Op};
use crate::pg::{ident, literal, qualified, DbError, PgClient};
use crate::state::{AppState, CancelToken};

pub const PROGRESS_EVENT: &str = "csv-import-progress";

const PREVIEW_ROWS: usize = 50;
const CHUNK: usize = 128 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
/// How skipped columns reach the server: every kept field is quoted but
/// NULL, which is written as this unquoted marker.
const REWRITE_NULL: &str = "\\N";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsvOptions {
    /// One character; `\t` for tab.
    pub delimiter: String,
    pub quote: String,
    /// The first row names the columns and is not loaded.
    pub header: bool,
    /// The text that means NULL. Empty: an empty field is NULL.
    pub null_string: String,
}

impl Default for CsvOptions {
    fn default() -> Self {
        CsvOptions {
            delimiter: ",".to_string(),
            quote: "\"".to_string(),
            header: true,
            null_string: String::new(),
        }
    }
}

impl CsvOptions {
    /// The delimiter and quote as the single bytes the format allows.
    fn bytes(&self) -> AppResult<(u8, u8)> {
        let one = |what: &str, text: &str| -> AppResult<u8> {
            let text = if text == "\\t" || text.eq_ignore_ascii_case("tab") {
                "\t"
            } else {
                text
            };
            match text.as_bytes() {
                [b] if b.is_ascii() && !matches!(b, b'\n' | b'\r') => Ok(*b),
                _ => Err(AppError::InvalidInput(format!(
                    "The {what} must be a single ASCII character."
                ))),
            }
        };
        let delimiter = one("delimiter", &self.delimiter)?;
        let quote = one("quote character", &self.quote)?;
        if delimiter == quote {
            return Err(AppError::InvalidInput(
                "The delimiter and the quote character must differ.".to_string(),
            ));
        }
        Ok((delimiter, quote))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    /// The first row, when the options say it holds names.
    pub headers: Option<Vec<String>>,
    /// The first rows after it; NULL where the field is the NULL text.
    pub rows: Vec<Vec<Option<String>>>,
    /// The widest row seen.
    pub columns: usize,
    pub total_bytes: u64,
    /// The file goes on past the rows shown.
    pub more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvProgress {
    pub execution_id: String,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub rows: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportSummary {
    /// Rows the server loaded.
    pub rows: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
}

/// The file, past a UTF-8 byte order mark (COPY would take it for data).
fn open(path: &Path) -> AppResult<(std::fs::File, u64)> {
    let mut file = std::fs::File::open(path)?;
    let total = file.metadata()?.len();
    let mut start = [0u8; 3];
    let mut got = 0;
    while got < 3 {
        match file.read(&mut start[got..])? {
            0 => break,
            n => got += n,
        }
    }
    let skip = if &start[..got] == UTF8_BOM { 3 } else { 0 };
    file.seek(SeekFrom::Start(skip))?;
    Ok((file, total))
}

fn reader(file: std::fs::File, options: &CsvOptions) -> AppResult<csv::Reader<std::fs::File>> {
    let (delimiter, quote) = options.bytes()?;
    Ok(csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .quote(quote)
        .from_reader(file))
}

fn csv_error(e: csv::Error) -> AppError {
    match e.position() {
        Some(p) => {
            AppError::InvalidInput(format!("The file can't be read at line {}: {e}", p.line()))
        }
        None => AppError::InvalidInput(format!("The file can't be read: {e}")),
    }
}

/// The first rows of the file as the options would read them.
pub fn preview(path: &Path, options: &CsvOptions) -> AppResult<CsvPreview> {
    let (file, total_bytes) = open(path)?;
    let mut records = reader(file, options)?;
    let mut headers = None;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut columns = 0;
    let mut more = false;
    let mut record = csv::ByteRecord::new();
    let mut first = options.header;
    let null = options.null_string.as_bytes();
    while records.read_byte_record(&mut record).map_err(csv_error)? {
        columns = columns.max(record.len());
        if first {
            first = false;
            headers = Some(
                record
                    .iter()
                    .map(|f| String::from_utf8_lossy(f).into_owned())
                    .collect(),
            );
            continue;
        }
        if rows.len() == PREVIEW_ROWS {
            more = true;
            break;
        }
        rows.push(
            record
                .iter()
                .map(|f| (f != null).then(|| String::from_utf8_lossy(f).into_owned()))
                .collect(),
        );
    }
    Ok(CsvPreview {
        headers,
        rows,
        columns,
        total_bytes,
        more,
    })
}

/// What the producer thread shares with the task sending to the server.
struct Shared {
    bytes: AtomicU64,
    rows: AtomicU64,
    cancel: Arc<AtomicBool>,
}

type Batch = Result<Vec<u8>, AppError>;

/// Counts the records of a CSV stream the server's way: a newline ends one
/// unless it is inside quotes. Right for well-formed files, which is all a
/// progress figure needs.
#[derive(Default)]
struct RowCounter {
    quote: u8,
    in_quotes: bool,
    lines: u64,
}

impl RowCounter {
    fn feed(&mut self, data: &[u8]) {
        for &b in data {
            if b == self.quote {
                self.in_quotes = !self.in_quotes;
            } else if b == b'\n' && !self.in_quotes {
                self.lines += 1;
            }
        }
    }
}

/// Sends the file's bytes as they are.
fn produce_raw(
    path: &Path,
    options: &CsvOptions,
    tx: &mpsc::Sender<Batch>,
    shared: &Shared,
) -> AppResult<()> {
    let (mut file, _) = open(path)?;
    let (_, quote) = options.bytes()?;
    let mut counter = RowCounter {
        quote,
        ..Default::default()
    };
    let skip_header = u64::from(options.header);
    loop {
        if shared.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let mut buf = vec![0u8; CHUNK];
        let n = match file.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        };
        buf.truncate(n);
        counter.feed(&buf);
        shared.bytes.fetch_add(n as u64, Ordering::Relaxed);
        shared
            .rows
            .store(counter.lines.saturating_sub(skip_header), Ordering::Relaxed);
        if tx.blocking_send(Ok(buf)).is_err() {
            return Ok(());
        }
    }
}

/// One record in the form the rewritten COPY reads.
fn render(record: &csv::ByteRecord, keep: &[usize], null: &[u8], out: &mut Vec<u8>) -> bool {
    for (n, &i) in keep.iter().enumerate() {
        let Some(field) = record.get(i) else {
            return false;
        };
        if n > 0 {
            out.push(b',');
        }
        if field == null {
            out.extend_from_slice(REWRITE_NULL.as_bytes());
        } else {
            out.push(b'"');
            for &b in field {
                if b == b'"' {
                    out.push(b'"');
                }
                out.push(b);
            }
            out.push(b'"');
        }
    }
    out.push(b'\n');
    true
}

/// The file's own fields (positions in `keep`), reformatted.
fn produce_rewritten(
    path: &Path,
    options: &CsvOptions,
    columns: usize,
    keep: &[usize],
    tx: &mpsc::Sender<Batch>,
    shared: &Shared,
) -> AppResult<()> {
    let (file, _) = open(path)?;
    let mut records = reader(file, options)?;
    let mut record = csv::ByteRecord::new();
    let mut batch = Vec::with_capacity(CHUNK + 4096);
    let mut skip = options.header;
    let null = options.null_string.as_bytes();
    let mut last_byte = 0;
    while records.read_byte_record(&mut record).map_err(csv_error)? {
        if skip {
            skip = false;
            last_byte = records.position().byte();
            continue;
        }
        if record.len() != columns {
            let line = record.position().map_or(0, |p| p.line());
            return Err(AppError::InvalidInput(format!(
                "Line {line} has {} fields, but the first row has {columns}.",
                record.len()
            )));
        }
        render(&record, keep, null, &mut batch);
        shared.rows.fetch_add(1, Ordering::Relaxed);
        if batch.len() >= CHUNK {
            let position = records.position().byte();
            shared
                .bytes
                .fetch_add(position - last_byte, Ordering::Relaxed);
            last_byte = position;
            if shared.cancel.load(Ordering::Relaxed)
                || tx.blocking_send(Ok(std::mem::take(&mut batch))).is_err()
            {
                return Ok(());
            }
        }
    }
    shared.bytes.fetch_add(
        records.position().byte().saturating_sub(last_byte),
        Ordering::Relaxed,
    );
    if !batch.is_empty() {
        let _ = tx.blocking_send(Ok(batch));
    }
    Ok(())
}

/// The file line behind a line of the rewritten stream: the server counts
/// the lines it was sent, which differ from the file's when fields hold
/// newlines or columns were skipped.
fn file_line_of(path: &Path, options: &CsvOptions, keep: &[usize], sent_line: u64) -> Option<u64> {
    let (file, _) = open(path).ok()?;
    let mut records = reader(file, options).ok()?;
    let mut record = csv::ByteRecord::new();
    let mut skip = options.header;
    let mut sent = 0u64;
    let mut line = Vec::new();
    while records.read_byte_record(&mut record).ok()? {
        if skip {
            skip = false;
            continue;
        }
        line.clear();
        render(&record, keep, options.null_string.as_bytes(), &mut line);
        sent += line.iter().filter(|&&b| b == b'\n').count() as u64;
        if sent >= sent_line {
            return record.position().map(|p| p.line());
        }
    }
    None
}

/// `line 12` out of the server's `COPY t, line 12, column x: "..."`.
fn context_line(context: &str) -> Option<u64> {
    let rest = &context[context.find("line ")? + 5..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// A server error with the line it happened on, when the server says.
fn load_error(
    e: &tokio_postgres::Error,
    path: &Path,
    options: &CsvOptions,
    keep: Option<&[usize]>,
) -> AppError {
    let mut db = DbError::from_pg(e);
    if db.is_cancel() {
        return AppError::Cancelled;
    }
    let context = e.as_db_error().and_then(|d| d.where_()).map(str::to_string);
    if let Some(context) = context {
        let sent = context_line(&context);
        let line = match (sent, keep) {
            // The rewritten stream has no header and its own line numbers.
            (Some(n), Some(keep)) => file_line_of(path, options, keep, n),
            (n, None) => n,
            _ => None,
        };
        if let Some(line) = line {
            db.message = format!("Line {line}: {}", db.message);
        }
        db.detail = Some(match db.detail.take() {
            Some(detail) => format!("{detail}\nCONTEXT: {context}"),
            None => format!("CONTEXT: {context}"),
        });
    }
    AppError::Database(Box::new(db))
}

/// Loads the file into `schema.table`. `mapping` has one entry per column
/// of the file: the table column it goes to, or none to skip it.
#[allow(clippy::too_many_arguments)]
pub async fn import_file(
    client: &PgClient,
    schema: &str,
    table: &str,
    path: &Path,
    mapping: &[Option<String>],
    options: &CsvOptions,
    token: &CancelToken,
    execution_id: &str,
    on_progress: impl Fn(CsvProgress),
) -> AppResult<CsvImportSummary> {
    options.bytes()?;
    let targets: Vec<&String> = mapping.iter().flatten().collect();
    if targets.is_empty() {
        return Err(AppError::InvalidInput(
            "Map at least one column of the file to a column of the table.".to_string(),
        ));
    }
    let columns = targets
        .iter()
        .map(|c| ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let raw = targets.len() == mapping.len();
    let keep: Vec<usize> = mapping
        .iter()
        .enumerate()
        .filter_map(|(i, m)| m.as_ref().map(|_| i))
        .collect();
    let with = if raw {
        let mut with = format!(
            "FORMAT csv, HEADER {}, DELIMITER {}, QUOTE {}",
            options.header,
            literal(&options.delimiter_text()),
            literal(&options.quote)
        );
        if !options.null_string.is_empty() {
            with.push_str(&format!(", NULL {}", literal(&options.null_string)));
        }
        with
    } else {
        format!(
            "FORMAT csv, HEADER false, DELIMITER ',', QUOTE '\"', NULL {}",
            literal(REWRITE_NULL)
        )
    };
    let sql = format!(
        "COPY {} ({columns}) FROM STDIN WITH ({with})",
        qualified(schema, table)
    );

    let total_bytes = std::fs::metadata(path)?.len();
    let started = Instant::now();
    let shared = Arc::new(Shared {
        bytes: AtomicU64::new(0),
        rows: AtomicU64::new(0),
        cancel: token.flag(),
    });
    let (tx, mut rx) = mpsc::channel::<Batch>(4);
    let producer = {
        let (path, options, keep, shared) = (
            path.to_path_buf(),
            options.clone(),
            keep.clone(),
            shared.clone(),
        );
        let fields = mapping.len();
        tokio::task::spawn_blocking(move || {
            let done = if raw {
                produce_raw(&path, &options, &tx, &shared)
            } else {
                produce_rewritten(&path, &options, fields, &keep, &tx, &shared)
            };
            if let Err(e) = done {
                let _ = tx.blocking_send(Err(e));
            }
        })
    };

    let sink = client
        .client
        .copy_in::<_, std::io::Cursor<Vec<u8>>>(&sql)
        .await;
    let sink = match sink {
        Ok(sink) => sink,
        Err(e) => {
            rx.close();
            let _ = producer.await;
            return Err(load_error(&e, path, options, None));
        }
    };
    let mut sink = Box::pin(sink);
    let keep_for_errors = (!raw).then_some(keep.as_slice());
    let mut last_progress = Instant::now();
    let failure = loop {
        let batch = tokio::select! {
            b = rx.recv() => b,
            () = token.cancelled() => break Some(AppError::Cancelled),
        };
        match batch {
            Some(Ok(bytes)) => {
                if let Err(e) = sink.send(std::io::Cursor::new(bytes)).await {
                    break Some(load_error(&e, path, options, keep_for_errors));
                }
            }
            Some(Err(e)) => break Some(e),
            None => break None,
        }
        if last_progress.elapsed() >= PROGRESS_EVERY {
            last_progress = Instant::now();
            on_progress(CsvProgress {
                execution_id: execution_id.to_string(),
                bytes_read: shared.bytes.load(Ordering::Relaxed).min(total_bytes),
                total_bytes,
                rows: shared.rows.load(Ordering::Relaxed),
            });
        }
    };
    rx.close();
    let _ = producer.await;
    if let Some(failure) = failure {
        // Dropping the sink aborts the COPY, so nothing is loaded.
        return Err(failure);
    }
    let rows = sink
        .as_mut()
        .finish()
        .await
        .map_err(|e| load_error(&e, path, options, keep_for_errors))?;
    Ok(CsvImportSummary {
        rows,
        bytes: total_bytes,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

impl CsvOptions {
    /// The delimiter as the character itself (`\t` is a tab).
    fn delimiter_text(&self) -> String {
        match self.bytes() {
            Ok((d, _)) => (d as char).to_string(),
            Err(_) => self.delimiter.clone(),
        }
    }
}

/// The first rows of a CSV file, for choosing how to load it.
#[tauri::command]
pub async fn preview_csv(path: String, options: CsvOptions) -> AppResult<CsvPreview> {
    let result = tokio::task::spawn_blocking(move || preview(Path::new(&path), &options))
        .await
        .map_err(|e| AppError::InvalidInput(format!("preview failed: {e}")))
        .flatten();
    logged("preview_csv", result)
}

/// Loads a CSV file into a table, streaming it from disk.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_csv<R: Runtime>(
    state: State<'_, AppState>,
    app: AppHandle<R>,
    session_id: String,
    database: String,
    schema: String,
    table: String,
    path: String,
    mapping: Vec<Option<String>>,
    options: CsvOptions,
    execution_id: String,
) -> AppResult<CsvImportSummary> {
    let s = logged("import_csv", session(&state, &session_id).await)?;
    if s.target.settings.read_only {
        return logged(
            "import_csv",
            Err(AppError::InvalidInput(
                "This connection is read-only. Edit the connection to allow changes.".to_string(),
            )),
        );
    }
    // Its own connection: an import can run for minutes.
    let key = format!("import:{execution_id}");
    let client = logged("import_csv", s.pinned(&key, &database).await)?;
    let token = track_task(&state, &execution_id, Some(client.canceller()));
    let started = Instant::now();
    let result = import_file(
        &client,
        &schema,
        &table,
        Path::new(&path),
        &mapping,
        &options,
        &token,
        &execution_id,
        |progress| {
            let _ = app.emit(PROGRESS_EVENT, progress);
        },
    )
    .await;
    forget_task(&state, &execution_id);
    s.release(&key).await;
    let target = format!("{schema}.{table}");
    let op = Op::new("csvImport", &database, Some(&target));
    match &result {
        Ok(summary) => log::info!(
            "{op} [{}] loaded {} rows in {} ms",
            s.name,
            summary.rows,
            started.elapsed().as_millis()
        ),
        Err(e) => logging::op_failed(&op, &s.name, started.elapsed(), e),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, contents: &[u8]) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("agent_scripts_{}_{name}", std::process::id()));
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn previews_quotes_newlines_nulls_and_ragged_rows() {
        let path = file(
            "preview.csv",
            b"\xEF\xBB\xBFid,note,extra\n1,\"he said \"\"hi\"\"\nthen left\",\\N\n2,plain\n3,,x,y\n",
        );
        let options = CsvOptions {
            null_string: "\\N".to_string(),
            ..Default::default()
        };
        let preview = preview(&path, &options).unwrap();
        assert_eq!(preview.headers.as_deref().unwrap(), ["id", "note", "extra"]);
        assert_eq!(preview.columns, 4);
        assert_eq!(
            preview.rows[0],
            [
                Some("1".to_string()),
                Some("he said \"hi\"\nthen left".to_string()),
                None
            ]
        );
        assert_eq!(preview.rows[1].len(), 2);
        assert_eq!(preview.rows[2][1].as_deref(), Some(""));
        assert!(!preview.more);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn previews_other_delimiters_and_files_without_a_header() {
        let path = file("tab.tsv", b"1\ta;b\t\n2\t'x\ty'\tz\n");
        let options = CsvOptions {
            delimiter: "\\t".to_string(),
            quote: "'".to_string(),
            header: false,
            ..Default::default()
        };
        let preview = preview(&path, &options).unwrap();
        assert!(preview.headers.is_none());
        assert_eq!(preview.rows.len(), 2);
        assert_eq!(preview.rows[0][2], None);
        assert_eq!(preview.rows[1][1].as_deref(), Some("x\ty"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_long_file_is_cut_after_fifty_rows() {
        let body: String = (0..120).map(|i| format!("{i},v\n")).collect();
        let path = file("long.csv", format!("a,b\n{body}").as_bytes());
        let preview = preview(&path, &CsvOptions::default()).unwrap();
        assert_eq!(preview.rows.len(), PREVIEW_ROWS);
        assert!(preview.more);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn delimiters_and_quotes_are_one_character() {
        let bad = |d: &str, q: &str| {
            CsvOptions {
                delimiter: d.to_string(),
                quote: q.to_string(),
                ..Default::default()
            }
            .bytes()
            .is_err()
        };
        assert!(bad("", "\""));
        assert!(bad(",,", "\""));
        assert!(bad(";", ";"));
        assert!(bad("é", "\""));
        assert!(bad("\n", "\""));
        let tab = CsvOptions {
            delimiter: "tab".to_string(),
            ..Default::default()
        };
        assert_eq!(tab.bytes().unwrap(), (b'\t', b'"'));
        assert_eq!(tab.delimiter_text(), "\t");
    }

    #[test]
    fn rewriting_quotes_everything_but_nulls() {
        let mut record = csv::ByteRecord::new();
        record.extend(["a \"b\"", "", "NULL", "line\nbreak"]);
        let mut out = Vec::new();
        assert!(render(&record, &[0, 1, 3], b"", &mut out));
        assert_eq!(out, b"\"a \"\"b\"\"\",\\N,\"line\nbreak\"\n");
        out.clear();
        assert!(render(&record, &[2, 0], b"NULL", &mut out));
        assert_eq!(out, b"\\N,\"a \"\"b\"\"\"\n");
        assert!(!render(&record, &[7], b"", &mut out));
    }

    #[test]
    fn rows_are_counted_outside_quotes() {
        let mut counter = RowCounter {
            quote: b'"',
            ..Default::default()
        };
        counter.feed(b"a,\"x\ny\"\"\nz\"\n1,2\n");
        counter.feed(b"3,\"par");
        counter.feed(b"t\nial\"\n");
        assert_eq!(counter.lines, 3);
    }

    #[test]
    fn the_failing_line_is_read_from_the_server_context() {
        assert_eq!(
            context_line("COPY orders, line 42, column total: \"abc\""),
            Some(42)
        );
        assert_eq!(context_line("COPY orders, line 7"), Some(7));
        assert_eq!(context_line("something else"), None);
    }

    #[test]
    fn a_rewritten_line_maps_back_to_the_file() {
        // record 2 holds a newline, so it takes two lines of what is sent
        let path = file("lines.csv", b"a,b,c\n1,x,y\n2,\"p\nq\",y\n3,z,y\n");
        let options = CsvOptions::default();
        let keep = [0, 1];
        assert_eq!(file_line_of(&path, &options, &keep, 1), Some(2));
        assert_eq!(file_line_of(&path, &options, &keep, 2), Some(3));
        assert_eq!(file_line_of(&path, &options, &keep, 3), Some(3));
        assert_eq!(file_line_of(&path, &options, &keep, 4), Some(5));
        assert_eq!(file_line_of(&path, &options, &keep, 5), None);
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the dev server (docker-compose.dev.yml). Run with:
    //!   POSTGRES_STUDIO_TEST_URI=postgres://postgres:postgres@localhost:5433/shop \
    //!     cargo test --lib -- --ignored csv_import::live_tests
    use super::*;
    use crate::pg::test_support::live_session;

    const CSV: &[u8] = b"id,name,note,qty\n\
        1,Ann,\"said \"\"hi\"\"\nand left\",5\n\
        2,\"Bo; the, third\",,\n\
        3,Cy,\\N,7\n\
        4,\"\",plain,8\n";

    fn file(name: &str, contents: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("agent_scripts_live_{name}"));
        std::fs::write(&path, contents).unwrap();
        path
    }

    fn cols(names: &[Option<&str>]) -> Vec<Option<String>> {
        names.iter().map(|n| n.map(str::to_string)).collect()
    }

    async fn run(
        client: &PgClient,
        path: &Path,
        mapping: &[Option<String>],
        options: &CsvOptions,
    ) -> AppResult<CsvImportSummary> {
        import_file(
            client,
            "public",
            "agent_scripts_people",
            path,
            mapping,
            options,
            &CancelToken::default(),
            "test",
            |_| {},
        )
        .await
    }

    async fn reset(client: &PgClient) {
        client
            .client
            .batch_execute(
                "DROP TABLE IF EXISTS public.agent_scripts_people; \
                 CREATE TABLE public.agent_scripts_people \
                 (id int primary key, name text, note text, qty int, \"Odd \"\"Col\" text)",
            )
            .await
            .unwrap();
    }

    async fn rows(client: &PgClient) -> Vec<(i32, Option<String>, Option<String>, Option<i32>)> {
        client
            .client
            .query(
                "SELECT id, name, note, qty FROM public.agent_scripts_people ORDER BY id",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
            .collect()
    }

    #[tokio::test]
    #[ignore]
    async fn live_imports_quotes_newlines_and_nulls() {
        let s = live_session().await;
        let client = s.pinned("import:test", "shop").await.unwrap();
        reset(&client).await;
        let path = file("people.csv", CSV);
        let mapping = cols(&[Some("id"), Some("name"), Some("note"), Some("qty")]);

        // As the server reads it: empty is NULL, a quoted empty is not.
        let done = run(&client, &path, &mapping, &CsvOptions::default())
            .await
            .unwrap();
        assert_eq!(done.rows, 4);
        let got = rows(&client).await;
        assert_eq!(got[0].2.as_deref(), Some("said \"hi\"\nand left"));
        assert_eq!(got[1].1.as_deref(), Some("Bo; the, third"));
        assert_eq!((got[1].2.clone(), got[1].3), (None, None));
        assert_eq!(got[2].2.as_deref(), Some("\\N"));
        assert_eq!(got[3].1.as_deref(), Some(""));

        // With a NULL text, an empty field is just empty.
        reset(&client).await;
        let options = CsvOptions {
            null_string: "\\N".to_string(),
            ..Default::default()
        };
        let nulls = file("nulls.csv", b"id,name,note,qty\n1,Ann,\\N,\\N\n2,Bo,,3\n");
        run(&client, &nulls, &mapping, &options).await.unwrap();
        let got = rows(&client).await;
        assert_eq!((got[0].2.clone(), got[0].3), (None, None));
        assert_eq!(got[1].2.as_deref(), Some(""));
        std::fs::remove_file(nulls).unwrap();

        // Skipping a column and mapping to an oddly named one: the rewrite path.
        reset(&client).await;
        let mapping = cols(&[Some("id"), None, Some("note"), Some("Odd \"Col")]);
        let options = CsvOptions {
            null_string: "\\N".to_string(),
            ..Default::default()
        };
        let done = run(&client, &path, &mapping, &options).await.unwrap();
        assert_eq!(done.rows, 4);
        let got = rows(&client).await;
        assert_eq!(got[0].2.as_deref(), Some("said \"hi\"\nand left"));
        assert_eq!(got[2].2, None);
        assert!(got.iter().all(|r| r.1.is_none()));
        let odd: Vec<Option<String>> = client
            .client
            .query(
                "SELECT \"Odd \"\"Col\" FROM public.agent_scripts_people ORDER BY id",
                &[],
            )
            .await
            .unwrap()
            .iter()
            .map(|r| r.get(0))
            .collect();
        assert_eq!(odd[0].as_deref(), Some("5"));
        assert_eq!(odd[1].as_deref(), Some(""));
        std::fs::remove_file(path).unwrap();

        // Another delimiter, no header.
        reset(&client).await;
        let path = file("people.psv", b"7|Dee|n|1\n8|Eve|\\N|2\n");
        let options = CsvOptions {
            delimiter: "|".to_string(),
            header: false,
            null_string: "\\N".to_string(),
            ..Default::default()
        };
        let mapping = cols(&[Some("id"), Some("name"), Some("note"), Some("qty")]);
        assert_eq!(
            run(&client, &path, &mapping, &options).await.unwrap().rows,
            2
        );
        assert_eq!(
            rows(&client).await[1],
            (8, Some("Eve".into()), None, Some(2))
        );
        std::fs::remove_file(path).unwrap();

        client
            .client
            .batch_execute("DROP TABLE public.agent_scripts_people")
            .await
            .unwrap();
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_a_bad_row_rolls_everything_back_and_names_its_line() {
        let s = live_session().await;
        let client = s.pinned("import:bad", "shop").await.unwrap();
        reset(&client).await;
        let bad = b"id,name,note,qty\n1,A,x,1\n2,\"B\nb\",y,2\n3,C,z,not-a-number\n4,D,w,4\n";
        let path = file("bad.csv", bad);
        let mapping = cols(&[Some("id"), Some("name"), Some("note"), Some("qty")]);
        let err = run(&client, &path, &mapping, &CsvOptions::default())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("Line 5:") && err.contains("integer"), "{err}");
        assert!(rows(&client).await.is_empty());

        // The same through the rewrite path, where the server's line differs.
        let mapping = cols(&[Some("id"), Some("name"), None, Some("qty")]);
        let err = run(&client, &path, &mapping, &CsvOptions::default())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("Line 5:") && err.contains("integer"), "{err}");
        assert!(rows(&client).await.is_empty());

        // A short row.
        std::fs::write(&path, "id,name,note,qty\n1,A,x,1\n2,B\n").unwrap();
        let err = run(&client, &path, &mapping, &CsvOptions::default())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("Line 3"), "{err}");

        // A column that doesn't exist.
        let mapping = cols(&[Some("id"), Some("nope"), Some("note"), Some("qty")]);
        let err = run(&client, &path, &mapping, &CsvOptions::default())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("nope"), "{err}");

        // The driver can't use a connection again after a COPY the server
        // refused to start; the command drops it, so the test does too.
        drop(client);
        s.release("import:bad").await;
        let client = s.pinned("import:bad", "shop").await.unwrap();

        client
            .client
            .batch_execute("DROP TABLE public.agent_scripts_people")
            .await
            .unwrap();
        std::fs::remove_file(path).unwrap();
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_imports_a_big_file_and_can_be_cancelled() {
        let s = live_session().await;
        let client = s.pinned("import:big", "shop").await.unwrap();
        reset(&client).await;
        let path = std::env::temp_dir().join("agent_scripts_live_big.csv");
        {
            use std::io::Write;
            let mut out = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
            writeln!(out, "id,name,note,qty").unwrap();
            for i in 0..500_000 {
                writeln!(out, "{i},\"name, {i}\",\"line\nbreak {i}\",{}", i % 100).unwrap();
            }
        }
        let size = std::fs::metadata(&path).unwrap().len();
        let mapping = cols(&[Some("id"), Some("name"), Some("note"), Some("qty")]);
        let started = Instant::now();
        let done = run(&client, &path, &mapping, &CsvOptions::default())
            .await
            .unwrap();
        eprintln!(
            "raw: {size} bytes, {} rows in {} ms",
            done.rows,
            started.elapsed().as_millis()
        );
        assert_eq!(done.rows, 500_000);
        reset(&client).await;
        let skipping = cols(&[Some("id"), None, Some("note"), Some("qty")]);
        let started = Instant::now();
        let done = run(&client, &path, &skipping, &CsvOptions::default())
            .await
            .unwrap();
        eprintln!(
            "rewritten: {} rows in {} ms",
            done.rows,
            started.elapsed().as_millis()
        );
        assert_eq!(done.rows, 500_000);
        let note: String = client
            .client
            .query_one(
                "SELECT note FROM public.agent_scripts_people WHERE id = 7",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(note, "line\nbreak 7");

        // Cancelled midway: nothing is kept.
        reset(&client).await;
        let token = CancelToken::default();
        let canceller = client.canceller();
        let stopper = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            canceller.cancel().await;
            stopper.cancel();
        });
        let err = import_file(
            &client,
            "public",
            "agent_scripts_people",
            &path,
            &mapping,
            &CsvOptions::default(),
            &token,
            "cancel",
            |_| {},
        )
        .await;
        assert!(matches!(err, Err(AppError::Cancelled)), "{err:?}");
        assert!(rows(&client).await.is_empty());

        client
            .client
            .batch_execute("DROP TABLE public.agent_scripts_people")
            .await
            .unwrap();
        std::fs::remove_file(path).unwrap();
        s.shutdown().await;
    }
}
