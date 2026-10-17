//! The console's optional psql engine: PostgreSQL's own client, run as a
//! process for each run, for what only psql does - meta-commands (`\d`,
//! `\copy`, `\i`, `\gexec`, `\set`, `\if`) and the user's `~/.psqlrc`.
//!
//! psql connects the way the console's session does: the session's
//! settings go in as `PG*` environment variables, the password among them,
//! never as arguments (see `dump::PgConn`). The script goes in on stdin,
//! which closes after it, so a command that waits for input ends instead
//! of hanging. Output comes back in psql's HTML format, the one that keeps
//! result sets apart: each `<table>` becomes a result like the built-in
//! engine's (psql doesn't say what type a column is), command tags and
//! `\echo` output become log lines, and errors on stderr become the failed
//! statement. Every line is also streamed to the windows as it arrives.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::dump::{self, PgConn, PgTool};
use crate::error::{AppError, AppResult};
use crate::pg::connect::Notice;
use crate::pg::run::{command_of, ResultColumn, SqlRun, StatementResult, TxState};
use crate::pg::{split, DbError, PgSession};
use crate::state::CancelToken;

/// `{ executionId, line }` for each line psql writes, as it writes it.
pub const LOG_EVENT: &str = "psql-log";

/// Lines kept for the run's log; the rest are counted.
const MAX_LOG: usize = 5000;
/// A line longer than this is cut.
const MAX_LINE: usize = 2000;
/// After a cancel, how long psql gets to end on its own.
const CANCEL_GRACE: Duration = Duration::from_millis(1500);

/// Where psql was found, or why it wasn't.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PsqlInfo {
    pub path: Option<String>,
    pub version: Option<String>,
    /// Whether `path` is the one the user picked.
    pub custom: bool,
    /// The picked executable didn't run as psql.
    pub error: Option<String>,
    /// Where the search looked, for the "not found" message.
    pub searched: Vec<String>,
}

/// Finds psql: the executable the user picked, else the newest one found
/// on the PATH and in the usual install folders.
pub async fn detect(custom_path: Option<&str>) -> PsqlInfo {
    if let Some(path) = custom_path.map(str::trim).filter(|p| !p.is_empty()) {
        return match dump::probe(PathBuf::from(path)).await {
            Some(tool) => PsqlInfo {
                path: Some(tool.path),
                version: Some(tool.version),
                custom: true,
                ..PsqlInfo::default()
            },
            None => PsqlInfo {
                path: Some(path.to_string()),
                custom: true,
                error: Some("This file didn't answer as psql (psql --version).".to_string()),
                ..PsqlInfo::default()
            },
        };
    }
    let tools = dump::find_tools().await;
    match tools.psql.into_iter().next() {
        Some(tool) => PsqlInfo {
            path: Some(tool.path),
            version: Some(tool.version),
            ..PsqlInfo::default()
        },
        None => PsqlInfo {
            searched: tools.searched,
            ..PsqlInfo::default()
        },
    }
}

/// How psql is started (Settings › Console).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PsqlOptions {
    /// An executable picked by hand; none uses the one found.
    #[serde(default)]
    pub path: Option<String>,
    /// Added after the app's own arguments, so they can override them.
    #[serde(default)]
    pub extra_args: String,
    /// Read `~/.psqlrc` (otherwise psql runs with `-X`).
    #[serde(default)]
    pub load_rc: bool,
    /// Stops a run that takes longer; none waits for as long as it takes.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// One line of a run's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Milliseconds since the run started.
    pub ms: u64,
    pub stream: LogStream,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    /// What psql printed: `\echo`, command tags, footers.
    Out,
    /// Errors, notices and warnings.
    Err,
    /// The app's own notes: how psql was started, how it ended.
    Info,
}

/// Splits extra arguments like a shell would: on spaces, with single or
/// double quotes keeping one argument together.
pub fn split_args(text: &str) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in text.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => current.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                started = true;
            }
            None if c.is_whitespace() => {
                if started {
                    args.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => {
                current.push(c);
                started = true;
            }
        }
    }
    if quote.is_some() {
        return Err("An extra argument has a quote that isn't closed.".to_string());
    }
    if started {
        args.push(current);
    }
    Ok(args)
}

/// What a NULL prints as: a mark no value will hold.
fn null_mark() -> String {
    format!(
        "\u{2400}psql-null-{}\u{2400}",
        uuid::Uuid::new_v4().simple()
    )
}

/// psql's arguments. The output settings go in as `-c` commands, which run
/// after `~/.psqlrc`, so a format set there can't change what is parsed.
pub fn args(options: &PsqlOptions, null: &str) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    if !options.load_rc {
        args.push("-X".into());
    }
    // Never ask for a password: it comes from the environment or not at all.
    args.push("-w".into());
    args.extend(["-v".into(), "ON_ERROR_STOP=1".into()]);
    args.extend(split_args(&options.extra_args)?);
    for command in [
        "\\set QUIET on".to_string(),
        "\\pset format html".to_string(),
        "\\pset pager off".to_string(),
        "\\pset footer on".to_string(),
        "\\pset tuples_only off".to_string(),
        "\\pset expanded off".to_string(),
        format!("\\pset null '{null}'"),
        "\\set QUIET off".to_string(),
    ] {
        args.push("-c".into());
        args.push(command);
    }
    args.extend(["-f".into(), "-".into()]);
    Ok(args)
}

// ---------------------------------------------------------------------------
// Reading psql's output
// ---------------------------------------------------------------------------

/// The text of HTML psql escaped (`html_escaped_print`).
fn unescape(html: &str) -> String {
    html.replace("<br />\n", "\n")
        .replace("<br />", "\n")
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// The content of `<tag ...>content</tag>` when `line` is exactly that.
fn element<'a>(line: &'a str, tag: &str) -> Option<&'a str> {
    let open = line.strip_prefix(&format!("<{tag}"))?;
    let at = open.find('>')?;
    open[at + 1..].strip_suffix(&format!("</{tag}>"))
}

#[derive(Default)]
struct Table {
    caption: Option<String>,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    total: u64,
    row: Option<Vec<Option<String>>>,
    /// A cell whose value spans lines, waiting for its `</td>`.
    cell: Option<String>,
}

/// An error or notice psql wrote, with the lines that belong to it.
struct ServerMessage {
    severity: String,
    message: String,
    /// The script line psql was on.
    line: Option<usize>,
    detail: Option<String>,
    hint: Option<String>,
    /// `LINE n: ...` and the caret under it.
    context_line: Option<(usize, String)>,
    caret: Option<usize>,
}

/// Turns psql's stdout and stderr, line by line, into results and a log.
pub struct OutputParser {
    row_limit: usize,
    null: String,
    started: Instant,
    table: Option<Table>,
    /// A `<p>` that spans lines.
    paragraph: Option<String>,
    pub results: Vec<StatementResult>,
    notices: Vec<Notice>,
    errors: Vec<ServerMessage>,
    current: Option<ServerMessage>,
    pub log: Vec<LogLine>,
    dropped: usize,
}

impl OutputParser {
    pub fn new(row_limit: usize, null: String) -> Self {
        Self {
            row_limit,
            null,
            started: Instant::now(),
            table: None,
            paragraph: None,
            results: Vec::new(),
            notices: Vec::new(),
            errors: Vec::new(),
            current: None,
            log: Vec::new(),
            dropped: 0,
        }
    }

    fn note(&mut self, stream: LogStream, text: &str) -> Option<LogLine> {
        let line = LogLine {
            ms: self.started.elapsed().as_millis() as u64,
            stream,
            text: clip(text),
        };
        if self.log.len() < MAX_LOG {
            self.log.push(line.clone());
        } else {
            self.dropped += 1;
        }
        Some(line)
    }

    /// A line of stdout; what it adds to the log, if anything.
    pub fn out_line(&mut self, line: &str) -> Vec<LogLine> {
        let mut logged = Vec::new();
        if let Some(mut text) = self.paragraph.take() {
            text.push('\n');
            text.push_str(line);
            match text.strip_suffix("</p>") {
                Some(done) => logged.extend(self.paragraph_done(done)),
                None => self.paragraph = Some(text),
            }
            return logged;
        }
        if self.table.is_some() {
            if let Some(result) = self.table_line(line) {
                let rows = result.row_count;
                let label = format!("{} · {} {}", result.command, rows, plural_rows(rows));
                self.results.push(result);
                logged.extend(self.note(LogStream::Out, &label));
            }
            return logged;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return logged;
        }
        if trimmed.starts_with("<table") && trimmed.ends_with('>') {
            self.table = Some(Table::default());
            return logged;
        }
        if let Some(rest) = trimmed.strip_prefix("<p>") {
            match rest.strip_suffix("</p>") {
                Some(done) => logged.extend(self.paragraph_done(done)),
                None => self.paragraph = Some(rest.to_string()),
            }
            return logged;
        }
        logged.extend(self.note(LogStream::Out, line));
        logged
    }

    /// A `<p>`: a table's footer, a command tag, or `\d`'s notes.
    fn paragraph_done(&mut self, html: &str) -> Vec<LogLine> {
        let text = unescape(html);
        let text = text.trim_end();
        // "(3 rows)" closes the table just read.
        if let Some(n) = text
            .strip_prefix('(')
            .and_then(|t| t.strip_suffix(" rows)").or_else(|| t.strip_suffix(" row)")))
            .and_then(|n| n.parse::<u64>().ok())
        {
            if let Some(last) = self.results.last_mut().filter(|r| r.returns_rows) {
                last.row_count = n;
                last.truncated = n as usize > last.rows.len();
            }
            return Vec::new();
        }
        if let Some(result) = command_tag(text, self.results.len()) {
            self.results.push(result);
        }
        let lines: Vec<String> = text.lines().map(str::to_string).collect();
        lines
            .iter()
            .filter_map(|l| self.note(LogStream::Out, l))
            .collect()
    }

    /// A line inside a `<table>`; the finished result at `</table>`.
    fn table_line(&mut self, line: &str) -> Option<StatementResult> {
        let null = self.null.clone();
        let row_limit = self.row_limit;
        let table = self.table.as_mut()?;
        if let Some(mut cell) = table.cell.take() {
            cell.push('\n');
            cell.push_str(line);
            match cell.strip_suffix("</td>") {
                Some(done) => {
                    let value = cell_value(done, &null);
                    if let Some(row) = table.row.as_mut() {
                        row.push(value);
                    }
                }
                None => table.cell = Some(cell),
            }
            return None;
        }
        let trimmed = line.trim_start();
        if let Some(caption) = element(trimmed, "caption") {
            table.caption = Some(unescape(caption));
        } else if let Some(name) = element(trimmed, "th") {
            table.columns.push(unescape(name));
        } else if trimmed.starts_with("<tr") {
            table.row = Some(Vec::new());
        } else if trimmed == "</tr>" {
            if let Some(row) = table.row.take() {
                // The header row is all `<th>`, so it ends with no cells.
                if !row.is_empty() {
                    table.total += 1;
                    if table.rows.len() < row_limit {
                        table.rows.push(row);
                    }
                }
            }
        } else if trimmed.starts_with("<td") {
            let open = &trimmed[trimmed.find('>').map_or(trimmed.len(), |i| i + 1)..];
            match open.strip_suffix("</td>") {
                Some(done) => {
                    let value = cell_value(done, &null);
                    if let Some(row) = table.row.as_mut() {
                        row.push(value);
                    }
                }
                None => table.cell = Some(open.to_string()),
            }
        } else if trimmed == "</table>" {
            let table = self.table.take()?;
            let index = self.results.len();
            return Some(StatementResult {
                index,
                start: 0,
                end: 0,
                command: table.caption.unwrap_or_else(|| "SELECT".to_string()),
                returns_rows: true,
                columns: table
                    .columns
                    .into_iter()
                    .map(|name| ResultColumn {
                        name,
                        type_name: String::new(),
                        type_oid: 0,
                    })
                    .collect(),
                truncated: table.total as usize > table.rows.len(),
                row_count: table.total,
                rows: table.rows,
                elapsed_ms: 0,
                error: None,
            });
        }
        None
    }

    /// A line of stderr; it's always logged.
    pub fn err_line(&mut self, line: &str) -> Vec<LogLine> {
        if let Some((script_line, severity, message)) = server_message(line) {
            self.close_message();
            self.current = Some(ServerMessage {
                severity,
                message,
                line: script_line,
                detail: None,
                hint: None,
                context_line: None,
                caret: None,
            });
        } else if let Some(current) = self.current.as_mut() {
            if let Some(detail) = line.strip_prefix("DETAIL:  ") {
                current.detail = Some(detail.to_string());
            } else if let Some(hint) = line.strip_prefix("HINT:  ") {
                current.hint = Some(hint.to_string());
            } else if let Some((n, text)) = line
                .strip_prefix("LINE ")
                .and_then(|rest| rest.split_once(": "))
                .and_then(|(n, text)| Some((n.parse::<usize>().ok()?, text)))
            {
                current.context_line = Some((n, text.to_string()));
            } else if let (Some((n, _)), Some(at)) = (&current.context_line, line.find('^')) {
                // The caret sits under the text, past "LINE n: ".
                let prefix = format!("LINE {n}: ").len();
                if line[..at].trim().is_empty() && at >= prefix {
                    current.caret = Some(at - prefix);
                }
            }
        }
        self.note(LogStream::Err, line).into_iter().collect()
    }

    fn close_message(&mut self) {
        let Some(message) = self.current.take() else {
            return;
        };
        if message.severity == "ERROR" || message.severity == "FATAL" {
            self.errors.push(message);
        } else {
            self.notices.push(Notice {
                severity: message.severity,
                message: message.message,
                detail: message.detail,
                hint: message.hint,
            });
        }
    }

    /// The results, with the errors placed on the statements of `script`
    /// they came from.
    pub fn finish(mut self, script: &str) -> (Vec<StatementResult>, Vec<Notice>, Vec<LogLine>) {
        self.close_message();
        if self.dropped > 0 {
            let text = format!("{} more lines not shown", self.dropped);
            self.log.push(LogLine {
                ms: self.started.elapsed().as_millis() as u64,
                stream: LogStream::Info,
                text,
            });
        }
        let statements = statements_of(script);
        for error in std::mem::take(&mut self.errors) {
            let index = self.results.len();
            self.results
                .push(error_result(index, script, &statements, error));
        }
        (self.results, self.notices, self.log)
    }
}

fn plural_rows(n: u64) -> &'static str {
    if n == 1 {
        "row"
    } else {
        "rows"
    }
}

fn clip(line: &str) -> String {
    match line.char_indices().nth(MAX_LINE) {
        Some((at, _)) => format!("{}...", &line[..at]),
        None => line.to_string(),
    }
}

/// A cell's value: `None` for the NULL mark, `""` for psql's blank cell.
fn cell_value(html: &str, null: &str) -> Option<String> {
    // psql writes a cell that is empty or only spaces as "&nbsp; ".
    if html == "&nbsp; " {
        return Some(String::new());
    }
    let value = unescape(html);
    (value != null).then_some(value)
}

/// `INSERT 0 3`, `UPDATE 2`, `CREATE TABLE`: a statement that returned no
/// rows, as a result.
fn command_tag(text: &str, index: usize) -> Option<StatementResult> {
    let first = text.lines().next()?;
    let words: Vec<&str> = first.split(' ').collect();
    let keywords: Vec<&str> = words
        .iter()
        .copied()
        .take_while(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_uppercase()))
        .collect();
    let numbers = &words[keywords.len()..];
    if keywords.is_empty()
        || text.lines().count() > 1
        || !numbers.iter().all(|w| w.parse::<u64>().is_ok())
    {
        return None;
    }
    Some(StatementResult {
        index,
        start: 0,
        end: 0,
        command: keywords.join(" "),
        returns_rows: false,
        columns: Vec::new(),
        rows: Vec::new(),
        // INSERT's tag is "INSERT oid count": the count comes last.
        row_count: numbers
            .last()
            .and_then(|n| n.parse().ok())
            .unwrap_or_default(),
        truncated: false,
        elapsed_ms: 0,
        error: None,
    })
}

/// `psql:<stdin>:12: ERROR:  message`, or `psql: error: ...` for psql's
/// own failures: (script line, severity, message).
fn server_message(line: &str) -> Option<(Option<usize>, String, String)> {
    let rest = line.strip_prefix("psql:")?;
    if let Some(own) = rest.strip_prefix(" error: ") {
        return Some((None, "ERROR".to_string(), own.to_string()));
    }
    // "<stdin>:12: ERROR:  message" (the file name has no colon here).
    let (_, rest) = rest.split_once(':')?;
    let (number, rest) = rest.split_once(": ")?;
    let script_line = number.parse::<usize>().ok();
    for severity in [
        "ERROR", "FATAL", "PANIC", "WARNING", "NOTICE", "INFO", "DEBUG", "LOG",
    ] {
        if let Some(message) = rest
            .strip_prefix(severity)
            .and_then(|m| m.strip_prefix(":"))
        {
            return Some((
                script_line,
                severity.to_string(),
                message.trim().to_string(),
            ));
        }
    }
    // psql's own problems on a line: "error: invalid command \foo".
    let message = rest.strip_prefix("error: ")?;
    Some((script_line, "ERROR".to_string(), message.to_string()))
}

/// The SQL statements of a psql script, its meta-command lines and COPY
/// data left out.
fn statements_of(script: &str) -> Vec<split::Statement> {
    let mut splitter = split::Splitter::new(split::SplitterOptions {
        meta_commands: true,
        copy_data: true,
    });
    let mut events = Vec::new();
    splitter.feed(script.as_bytes(), &mut events);
    splitter.finish(&mut events);
    events
        .into_iter()
        .filter_map(|e| match e {
            split::Event::Statement(s) | split::Event::CopyStart(s) => Some(s),
            _ => None,
        })
        .collect()
}

/// The 1-based line of byte offset `at`.
fn line_of(script: &str, at: usize) -> usize {
    script[..at.min(script.len())].matches('\n').count() + 1
}

/// A failed statement: the one in `statements` psql was on when it failed,
/// else the line it named.
fn error_result(
    index: usize,
    script: &str,
    statements: &[split::Statement],
    error: ServerMessage,
) -> StatementResult {
    let statement = error.line.and_then(|line| {
        statements.iter().find(|s| {
            let end = script[s.end..]
                .find(';')
                .map_or(s.end, |semi| s.end + semi + 1);
            (line_of(script, s.start)..=line_of(script, end)).contains(&line)
        })
    });
    let (start, end, command, position) = match statement {
        Some(s) => {
            let position =
                error
                    .context_line
                    .as_ref()
                    .zip(error.caret)
                    .and_then(|((n, text), caret)| {
                        // Only when psql showed the line whole, not cut with "...".
                        let line = s.text.lines().nth(n.checked_sub(1)?)?;
                        // psql's line goes on to the semicolon, and past it.
                        let line = line.trim_end();
                        (!line.is_empty()
                            && text.starts_with(line)
                            && caret <= line.chars().count())
                        .then(|| {
                            let before: usize = s
                                .text
                                .lines()
                                .take(n - 1)
                                .map(|l| l.chars().count() + 1)
                                .sum();
                            (before + caret + 1) as u32
                        })
                    });
            (
                script[..s.start].chars().count(),
                script[..s.end].chars().count(),
                command_of(&s.text),
                position,
            )
        }
        None => {
            let (start, end) = error.line.map_or((0, 0), |line| line_span(script, line));
            (start, end, "Statement".to_string(), None)
        }
    };
    StatementResult {
        index,
        start,
        end,
        command,
        returns_rows: false,
        columns: Vec::new(),
        rows: Vec::new(),
        row_count: 0,
        truncated: false,
        elapsed_ms: 0,
        error: Some(DbError {
            message: error.message,
            code: None,
            detail: error.detail,
            hint: error.hint,
            position,
            severity: Some(error.severity),
        }),
    }
}

/// Character offsets of the 1-based `line`.
fn line_span(script: &str, line: usize) -> (usize, usize) {
    let mut start = 0;
    for (i, text) in script.split('\n').enumerate() {
        let len = text.chars().count();
        if i + 1 == line {
            return (start, start + len);
        }
        start += len + 1;
    }
    (0, 0)
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

/// psql, as it is set up and found.
pub async fn resolve(options: &PsqlOptions) -> AppResult<PgTool> {
    let info = detect(options.path.as_deref()).await;
    if let Some(error) = info.error {
        return Err(AppError::Tool(error));
    }
    let (Some(path), Some(version)) = (info.path, info.version) else {
        return Err(AppError::Tool(
            "psql wasn't found. Install PostgreSQL's client tools, or pick psql in Settings › Console."
                .to_string(),
        ));
    };
    Ok(PgTool {
        major: dump::major_of(&version).unwrap_or(0),
        path,
        version,
    })
}

enum Line {
    Out(String),
    Err(String),
}

/// Sends a stream's lines, whole, until it closes.
async fn pump(stream: impl AsyncRead + Unpin, tx: mpsc::UnboundedSender<Line>, err: bool) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf)
                    .trim_end_matches(['\n', '\r'])
                    .to_string();
                let line = if err {
                    Line::Err(text)
                } else {
                    Line::Out(text)
                };
                if tx.send(line).is_err() {
                    return;
                }
            }
        }
    }
}

/// How a run ended when it didn't end by itself.
enum Stopped {
    Cancelled,
    TimedOut(u64),
}

/// Runs `script` with psql on `database` of `session`, streaming each line
/// to `on_log`. A failed statement is a result with an error, as with the
/// built-in engine; failing to start psql or to connect is an `Err`.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    session: Arc<PgSession>,
    database: &str,
    script: &str,
    options: &PsqlOptions,
    row_limit: usize,
    execution_id: &str,
    cancel: &CancelToken,
    on_log: impl Fn(&LogLine),
) -> AppResult<SqlRun> {
    let tool = resolve(options).await?;
    let null = null_mark();
    let args = args(options, &null).map_err(AppError::InvalidInput)?;
    let started = Instant::now();
    let mut parser = OutputParser::new(row_limit, null);

    let mut conn = PgConn::from_target(&session.target);
    // Named so a cancel can find psql's backend and stop its statement.
    let app_name = format!("Postgres Studio psql {execution_id}");
    conn.app_name = Some(app_name.clone());
    let env = conn.env(database, tool.major);
    let mut command = Command::new(&tool.path);
    command.args(&args);
    for key in dump::STRAY_ENV {
        command.env_remove(key);
    }
    for (key, value) in &env {
        command.env(key, value);
    }
    command
        .env("PGCLIENTENCODING", "UTF8")
        .env("PG_COLOR", "never")
        .env("LC_MESSAGES", "C")
        .env("LANGUAGE", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    dump::hide_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| AppError::Tool(format!("Couldn't start psql: {e}")))?;

    let host = conn.host.clone().unwrap_or_default();
    let user = conn.user.clone().unwrap_or_default();
    let port = conn.port.clone().unwrap_or_default();
    let startup = format!(
        "psql {} · {user}@{host}:{port}/{database} · password from the environment{}",
        tool.version,
        if options.load_rc { " · ~/.psqlrc" } else { "" }
    );
    if let Some(line) = parser.note(LogStream::Info, &startup) {
        on_log(&line);
    }

    // The script, then end of input: nothing can wait for more.
    if let Some(mut stdin) = child.stdin.take() {
        let script = script.to_string();
        tokio::spawn(async move {
            let mut text = script;
            if !text.ends_with('\n') {
                text.push('\n');
            }
            let _ = stdin.write_all(text.as_bytes()).await;
        });
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    if let Some(out) = child.stdout.take() {
        tokio::spawn(pump(out, tx.clone(), false));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(pump(err, tx.clone(), true));
    }
    drop(tx);

    let deadline = options
        .timeout_secs
        .filter(|s| *s > 0)
        .map(|s| tokio::time::Instant::now() + Duration::from_secs(s));
    let mut stopped = None;
    loop {
        let line = tokio::select! {
            line = rx.recv() => line,
            () = cancel.cancelled(), if stopped.is_none() => {
                stopped = Some(Stopped::Cancelled);
                stop_backend(&session, database, &app_name).await;
                break;
            }
            () = sleep_until(deadline), if stopped.is_none() => {
                stopped = Some(Stopped::TimedOut(options.timeout_secs.unwrap_or_default()));
                stop_backend(&session, database, &app_name).await;
                break;
            }
        };
        let Some(line) = line else { break };
        let logged = match line {
            Line::Out(text) => parser.out_line(&text),
            Line::Err(text) => parser.err_line(&text),
        };
        for line in &logged {
            on_log(line);
        }
    }
    if stopped.is_some() {
        // psql's statement was cancelled; it ends on its own, or is ended.
        if tokio::time::timeout(CANCEL_GRACE, child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
        while let Ok(line) = rx.try_recv() {
            match line {
                Line::Out(text) => parser.out_line(&text),
                Line::Err(text) => parser.err_line(&text),
            };
        }
    }
    let status = child.wait().await.ok();
    let code = status.and_then(|s| s.code());

    let (mut results, notices, mut log) = parser.finish(script);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let ending = match &stopped {
        Some(Stopped::Cancelled) => "Cancelled: psql was stopped".to_string(),
        Some(Stopped::TimedOut(secs)) => format!("Stopped after the time limit ({secs} s)"),
        None => match code {
            Some(code) => format!("psql exited with {code} · {elapsed_ms} ms"),
            None => format!("psql was ended by a signal · {elapsed_ms} ms"),
        },
    };
    let ending_line = LogLine {
        ms: elapsed_ms,
        stream: LogStream::Info,
        text: ending.clone(),
    };
    on_log(&ending_line);
    log.push(ending_line);

    if let Some(stopped) = stopped {
        let message = match stopped {
            Stopped::Cancelled => "canceling statement due to user request".to_string(),
            Stopped::TimedOut(_) => ending,
        };
        // The statement the cancel stopped failed with the server's
        // "canceling statement": it says why it stopped instead.
        if let Some(error) = results
            .iter_mut()
            .filter_map(|r| r.error.as_mut())
            .find(|e| {
                e.message
                    .contains("canceling statement due to user request")
            })
        {
            error.message = message.clone();
            error.code = Some("57014".to_string());
        }
        if !results.iter().any(|r| r.error.is_some()) {
            results.push(StatementResult {
                index: results.len(),
                start: 0,
                end: 0,
                command: "psql".to_string(),
                returns_rows: false,
                columns: Vec::new(),
                rows: Vec::new(),
                row_count: 0,
                truncated: false,
                elapsed_ms,
                error: Some(DbError {
                    message,
                    code: Some("57014".to_string()),
                    detail: None,
                    hint: None,
                    position: None,
                    severity: Some("ERROR".to_string()),
                }),
            });
        }
    } else if code != Some(0) && !results.iter().any(|r| r.error.is_some()) {
        // psql failed on its own (it couldn't connect, say): what it wrote
        // last says why.
        let why = log
            .iter()
            .rev()
            .filter(|l| l.stream == LogStream::Err)
            .map(|l| l.text.as_str())
            .next()
            .unwrap_or("psql failed")
            .trim_start_matches("psql: error: ")
            .to_string();
        return Err(AppError::Tool(why));
    }
    Ok(SqlRun {
        results,
        notices,
        transaction: TxState::Idle,
        elapsed_ms,
        log: Some(log),
    })
}

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// Cancels the statement psql's connection is running, found by the
/// application name it connected with.
async fn stop_backend(session: &PgSession, database: &str, app_name: &str) {
    let Ok(client) = session.client(database).await else {
        return;
    };
    let sql = format!(
        "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name = {}",
        crate::pg::literal(app_name)
    );
    if let Err(e) = client.client.simple_query(&sql).await {
        log::warn!("psql: couldn't cancel its statement on the server: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(
        out: &str,
        err: &str,
        script: &str,
    ) -> (Vec<StatementResult>, Vec<Notice>, Vec<LogLine>) {
        let mut p = OutputParser::new(1000, "NULLMARK".to_string());
        for line in out.lines() {
            p.out_line(line);
        }
        for line in err.lines() {
            p.err_line(line);
        }
        p.finish(script)
    }

    const OUT: &str = r#"<table border="1">
  <tr>
    <th align="center">a</th>
    <th align="center">b</th>
    <th align="center">c</th>
    <th align="center">d</th>
    <th align="center">e</th>
    <th align="center">f</th>
  </tr>
  <tr valign="top">
    <td align="right">1</td>
    <td align="left">NULLMARK</td>
    <td align="left">&nbsp; </td>
    <td align="left">&nbsp;&nbsp;x</td>
    <td align="left">l1<br />
l2</td>
    <td align="left">&lt;b&gt;&amp;&quot;</td>
  </tr>
</table>
<p>(1 row)<br />
</p>
hello <there>
<p>CREATE TABLE</p>
<p>INSERT 0 2</p>
<table border="1">
  <caption>Table &quot;pg_temp_2.t&quot;</caption>
  <tr>
    <th align="center">Column</th>
    <th align="center">Type</th>
  </tr>
  <tr valign="top">
    <td align="left">x</td>
    <td align="left">integer</td>
  </tr>
</table>
<p>Indexes:<br />
&nbsp;&nbsp;&nbsp;&nbsp;&quot;t_pkey&quot; PRIMARY KEY, btree (x)<br />
</p>
"#;

    #[test]
    fn reads_tables_tags_and_echo() {
        let (results, _, log) = parse(OUT, "", "");
        assert_eq!(results.len(), 4);
        let first = &results[0];
        assert!(first.returns_rows);
        assert_eq!(first.command, "SELECT");
        let names: Vec<&str> = first.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c", "d", "e", "f"]);
        assert_eq!(
            first.rows[0],
            vec![
                Some("1".to_string()),
                None,
                Some(String::new()),
                Some("  x".to_string()),
                Some("l1\nl2".to_string()),
                Some("<b>&\"".to_string()),
            ]
        );
        assert_eq!(first.row_count, 1);
        assert_eq!(results[1].command, "CREATE TABLE");
        assert!(!results[1].returns_rows);
        assert_eq!(
            (results[2].command.as_str(), results[2].row_count),
            ("INSERT", 2)
        );
        assert_eq!(results[3].command, "Table \"pg_temp_2.t\"");
        assert_eq!(results[3].rows.len(), 1);
        let texts: Vec<&str> = log.iter().map(|l| l.text.as_str()).collect();
        assert!(texts.contains(&"hello <there>"));
        assert!(texts.contains(&"INSERT 0 2"));
        assert!(texts.contains(&"    \"t_pkey\" PRIMARY KEY, btree (x)"));
    }

    #[test]
    fn keeps_rows_up_to_the_limit_and_counts_the_rest() {
        let mut p = OutputParser::new(2, "N".to_string());
        p.out_line("<table border=\"1\">");
        p.out_line("  <tr><th align=\"center\">x</th></tr>");
        for i in 0..5 {
            p.out_line("  <tr valign=\"top\">");
            p.out_line(&format!("    <td align=\"right\">{i}</td>"));
            p.out_line("  </tr>");
        }
        p.out_line("</table>");
        p.out_line("<p>(5 rows)<br />");
        p.out_line("</p>");
        let (results, _, _) = p.finish("");
        assert_eq!(results[0].rows.len(), 2);
        assert_eq!(results[0].row_count, 5);
        assert!(results[0].truncated);
    }

    #[test]
    fn places_an_error_on_its_statement() {
        let script = "select 1;\n\\echo hi\nselect *\n  from nope;\nselect 2;";
        let err = "psql:<stdin>:4: ERROR:  relation \"nope\" does not exist\nLINE 2:   from nope;\n               ^\nHINT:  Check the name.";
        let (results, _, log) = parse("", err, script);
        let failed = results.last().unwrap();
        let error = failed.error.as_ref().unwrap();
        assert_eq!(error.message, "relation \"nope\" does not exist");
        assert_eq!(error.hint.as_deref(), Some("Check the name."));
        assert_eq!(failed.command, "SELECT");
        // The statement starts at "select *" and the caret is under "nope".
        let start = script.find("select *").unwrap();
        assert_eq!(failed.start, start);
        let position = error.position.unwrap() as usize;
        assert_eq!(&script[start + position - 1..start + position + 3], "nope");
        assert_eq!(log.len(), 4);
    }

    #[test]
    fn notices_are_kept_apart_from_errors() {
        let err = "psql:<stdin>:1: NOTICE:  table \"x\" does not exist, skipping";
        let (results, notices, _) = parse("<p>DROP TABLE</p>", err, "drop table if exists x;");
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].severity, "NOTICE");
        assert!(results.iter().all(|r| r.error.is_none()));
    }

    #[test]
    fn psql_s_own_errors_count() {
        let (results, _, _) = parse(
            "",
            "psql:<stdin>:2: error: invalid command \\nope",
            "select 1;\n\\nope",
        );
        let error = results[0].error.as_ref().unwrap();
        assert_eq!(error.message, "invalid command \\nope");
        assert_eq!(results[0].start, 10);
    }

    #[test]
    fn splits_extra_arguments_like_a_shell() {
        assert_eq!(
            split_args(r#"-v ON_ERROR_STOP=0 --set "name=a b" -c 'x y'"#).unwrap(),
            vec!["-v", "ON_ERROR_STOP=0", "--set", "name=a b", "-c", "x y"]
        );
        assert!(split_args("'open").is_err());
        assert!(split_args("   ").unwrap().is_empty());
    }

    #[test]
    fn the_rc_file_is_skipped_unless_asked_for() {
        let mut options = PsqlOptions::default();
        let off = args(&options, "N").unwrap();
        assert_eq!(off[0], "-X");
        assert!(off.contains(&"-w".to_string()));
        options.load_rc = true;
        options.extra_args = "-v ON_ERROR_STOP=0".into();
        let on = args(&options, "N").unwrap();
        assert!(!on.contains(&"-X".to_string()));
        // The user's arguments come after the app's, so they win.
        let stop = on.iter().position(|a| a == "ON_ERROR_STOP=1").unwrap();
        let theirs = on.iter().position(|a| a == "ON_ERROR_STOP=0").unwrap();
        assert!(theirs > stop);
        assert_eq!(&on[on.len() - 2..], ["-f", "-"]);
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the dev server (docker-compose.dev.yml). Run with:
    //!   POSTGRES_STUDIO_TEST_URI=postgres://postgres:postgres@localhost:5433/shop \
    //!     cargo test --lib -- --ignored psql::live_tests
    //! Needs psql; `POSTGRES_STUDIO_PG_BIN` names a folder with one. When
    //! there is none, the tests say so and pass.
    use super::*;
    use crate::models::{
        ConnectionAdvancedOptions, ConnectionProfile, ConnectionSource, SslMode, TlsOptions,
    };
    use crate::secrets::InMemoryStore;
    use std::sync::Mutex;

    async fn session() -> Option<Arc<PgSession>> {
        if detect(None).await.path.is_none() {
            eprintln!("psql isn't installed: skipped");
            return None;
        }
        let uri = std::env::var("POSTGRES_STUDIO_TEST_URI").expect("set POSTGRES_STUDIO_TEST_URI");
        let profile = ConnectionProfile {
            id: "live".into(),
            name: "live".into(),
            color: None,
            source: ConnectionSource::Uri { uri },
            database: None,
            username: None,
            has_password: false,
            tls: TlsOptions {
                ssl_mode: SslMode::Disable,
                ..Default::default()
            },
            ssh_tunnel: None,
            advanced: ConnectionAdvancedOptions::default(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let known = Arc::new(crate::ssh_tunnel::KnownHosts::load(&std::env::temp_dir()).unwrap());
        Some(Arc::new(
            PgSession::connect(&profile, &InMemoryStore::new(), &known)
                .await
                .unwrap(),
        ))
    }

    async fn run_script(
        session: Arc<PgSession>,
        script: &str,
        options: PsqlOptions,
        cancel: &CancelToken,
    ) -> (AppResult<SqlRun>, Vec<LogLine>) {
        let id = uuid::Uuid::new_v4().to_string();
        run_as(session, script, options, cancel, &id).await
    }

    /// Tests run side by side: each run needs its own execution id, which
    /// is what a cancel looks for on the server.
    async fn run_as(
        session: Arc<PgSession>,
        script: &str,
        options: PsqlOptions,
        cancel: &CancelToken,
        execution_id: &str,
    ) -> (AppResult<SqlRun>, Vec<LogLine>) {
        let streamed = Mutex::new(Vec::new());
        let run = run(
            session,
            "shop",
            script,
            &options,
            1000,
            execution_id,
            cancel,
            |l| streamed.lock().unwrap().push(l.clone()),
        )
        .await;
        (run, streamed.into_inner().unwrap())
    }

    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn runs_a_script_with_meta_commands() {
        let Some(session) = session().await else {
            return;
        };
        let script = "\\set n 3\n\\echo counting to :n\nSELECT g AS n, NULL::text AS nothing FROM generate_series(1, :n) g;\nCREATE TEMP TABLE psql_live (x int);\nINSERT INTO psql_live VALUES (1), (2);\n\\d psql_live";
        let (run, streamed) = run_script(
            session,
            script,
            PsqlOptions::default(),
            &CancelToken::default(),
        )
        .await;
        let run = run.unwrap();
        let rows = &run.results[0];
        assert!(rows.returns_rows);
        assert_eq!(rows.row_count, 3);
        assert_eq!(rows.rows[2], vec![Some("3".to_string()), None]);
        let commands: Vec<&str> = run.results.iter().map(|r| r.command.as_str()).collect();
        assert!(commands.contains(&"CREATE TABLE"), "{commands:?}");
        assert!(commands.contains(&"INSERT"), "{commands:?}");
        assert!(
            commands.iter().any(|c| c.starts_with("Table ")),
            "{commands:?}"
        );
        let log = run.log.unwrap();
        assert!(log.iter().any(|l| l.text == "counting to 3"));
        assert!(log
            .first()
            .unwrap()
            .text
            .contains("password from the environment"));
        // Every line went out as it came, the ending included.
        assert_eq!(streamed.len(), log.len());
        assert!(log.iter().all(|l| !l.text.contains("postgres:postgres")));
    }

    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn stops_at_the_first_error() {
        let Some(session) = session().await else {
            return;
        };
        let script = "SELECT 1;\nSELECT *\n  FROM no_such_table;\nSELECT 2;";
        let (run, _) = run_script(
            session,
            script,
            PsqlOptions::default(),
            &CancelToken::default(),
        )
        .await;
        let run = run.unwrap();
        assert_eq!(
            run.results.len(),
            2,
            "the statement after the error didn't run"
        );
        let failed = &run.results[1];
        let error = failed.error.as_ref().unwrap();
        assert!(error.message.contains("no_such_table"), "{error:?}");
        assert_eq!(failed.start, script.find("SELECT *").unwrap());
        let position = error.position.expect("position") as usize;
        assert_eq!(
            &script[failed.start + position - 1..][..13],
            "no_such_table"
        );
    }

    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn cancelling_stops_the_statement_and_psql() {
        let Some(session) = session().await else {
            return;
        };
        let cancel = CancelToken::default();
        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            stopper.cancel();
        });
        let started = Instant::now();
        let id = uuid::Uuid::new_v4().to_string();
        let (run, _) = run_as(
            session.clone(),
            "SELECT pg_sleep(30);",
            PsqlOptions::default(),
            &cancel,
            &id,
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(10));
        let run = run.unwrap();
        let error = run.results.last().unwrap().error.as_ref().unwrap();
        assert!(error.message.contains("cancel"), "{error:?}");
        // Nothing of psql's is left running on the server.
        let client = session.client("shop").await.unwrap();
        let left = client
            .client
            .simple_query(&format!(
                "SELECT count(*) FROM pg_stat_activity \
                 WHERE application_name = 'Postgres Studio psql {id}' AND state = 'active'"
            ))
            .await
            .unwrap();
        let count = left.iter().find_map(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(r) => r.get(0).map(str::to_string),
            _ => None,
        });
        assert_eq!(count.as_deref(), Some("0"));
    }

    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn the_time_limit_ends_a_run_and_input_never_waits() {
        let Some(session) = session().await else {
            return;
        };
        let options = PsqlOptions {
            timeout_secs: Some(1),
            ..PsqlOptions::default()
        };
        let started = Instant::now();
        let (run, _) = run_script(
            session.clone(),
            "SELECT pg_sleep(20);",
            options,
            &CancelToken::default(),
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(8));
        let error = run.unwrap().results.last().unwrap().error.clone().unwrap();
        assert!(error.message.contains("time limit"), "{error:?}");

        // \prompt reads stdin, which is already closed: it can't hang.
        let (run, _) = run_script(
            session,
            "\\prompt 'Name? ' name\nSELECT 'done';",
            PsqlOptions::default(),
            &CancelToken::default(),
        )
        .await;
        assert!(run.is_ok());
    }
}
