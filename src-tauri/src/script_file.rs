//! Running a SQL file: a hand-written script or a plain `pg_dump`.
//!
//! The file is read in pieces and fed to the incremental splitter, so its
//! size is no limit; at most one statement is in memory. Each statement
//! runs on the script's own connection, in order. `COPY ... FROM stdin`
//! blocks stream their data lines into the server, which is what makes a
//! plain-format dump restorable; psql meta-commands (`\connect`, `\set`)
//! can't be honored and are skipped with a warning.

use std::io::{Cursor, Read};
use std::path::Path;
use std::pin::Pin;
use std::time::{Duration, Instant};

use futures_util::{pin_mut, SinkExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio_postgres::CopyInSink;

use crate::commands::{forget_task, session, track_task};
use crate::error::{AppError, AppResult};
use crate::logging::{self, logged, Op};
use crate::pg::split::{Event, Splitter, SplitterOptions, Statement};
use crate::pg::{DbError, PgClient};
use crate::state::{AppState, CancelToken};

pub const PROGRESS_EVENT: &str = "script-progress";

const CHUNK: usize = 128 * 1024;
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
/// Errors and warnings kept for the summary; the counts go on past this.
const KEPT: usize = 500;
const PREVIEW_CHARS: usize = 80;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScriptOptions {
    /// Stop at the first failing statement; otherwise go on and list them.
    pub stop_on_error: bool,
    /// Run it all in one transaction, rolled back on an error. The first
    /// error aborts a transaction, so this always stops there.
    pub single_transaction: bool,
}

impl Default for ScriptOptions {
    fn default() -> Self {
        ScriptOptions {
            stop_on_error: true,
            single_transaction: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptProgress {
    pub execution_id: String,
    pub statements_done: u64,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub errors: u64,
    /// The start of the statement running now.
    pub current_preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptError {
    /// 1-based position among the statements.
    pub index: u64,
    /// Line the statement starts on.
    pub line: u64,
    pub message: String,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptWarning {
    pub line: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSummary {
    /// Statements run, failed ones included.
    pub statements: u64,
    /// The first errors; `error_count` is how many there were.
    pub errors: Vec<ScriptError>,
    pub error_count: u64,
    pub warnings: Vec<ScriptWarning>,
    pub warning_count: u64,
    /// Rows loaded by `COPY ... FROM stdin` blocks.
    pub copied_rows: u64,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    /// Ended at an error, before the end of the file.
    pub stopped: bool,
    /// A single-transaction run that undid its work.
    pub rolled_back: bool,
}

/// How a statement ended when it didn't succeed.
enum Failure {
    Cancelled,
    Failed(Box<DbError>),
}

type Sink = Pin<Box<CopyInSink<Cursor<Vec<u8>>>>>;

struct Run<'a, F> {
    client: &'a PgClient,
    token: &'a CancelToken,
    execution_id: &'a str,
    on_progress: F,
    stop_on_error: bool,
    started: Instant,
    last_progress: Instant,
    total_bytes: u64,
    bytes_read: u64,
    statements: u64,
    errors: Vec<ScriptError>,
    error_count: u64,
    warnings: Vec<ScriptWarning>,
    warning_count: u64,
    copied_rows: u64,
    cancelled: bool,
    stopped: bool,
    /// The COPY being fed: where it started, and the connection's sink.
    copy: Option<(u64, u64, Sink)>,
}

/// Whether to go on reading.
#[derive(PartialEq, Eq)]
enum Flow {
    Go,
    Stop,
}

impl<F: FnMut(ScriptProgress)> Run<'_, F> {
    fn progress(&mut self, preview: &str) {
        if self.last_progress.elapsed() < PROGRESS_EVERY {
            return;
        }
        self.last_progress = Instant::now();
        (self.on_progress)(ScriptProgress {
            execution_id: self.execution_id.to_string(),
            statements_done: self.statements.saturating_sub(1),
            bytes_read: self.bytes_read,
            total_bytes: self.total_bytes,
            errors: self.error_count,
            current_preview: preview.to_string(),
        });
    }

    fn warn(&mut self, line: u64, message: String) {
        self.warning_count += 1;
        if self.warnings.len() < KEPT {
            self.warnings.push(ScriptWarning { line, message });
        }
    }

    /// Records a failed statement; stops the run if it should.
    fn fail(&mut self, index: u64, line: u64, error: &DbError) -> Flow {
        self.error_count += 1;
        if self.errors.len() < KEPT {
            self.errors.push(ScriptError {
                index,
                line,
                message: error.to_string(),
                code: error.code.clone(),
            });
        }
        // A closed connection can't run what is left.
        if self.stop_on_error || self.client.is_closed() {
            self.stopped = true;
            Flow::Stop
        } else {
            Flow::Go
        }
    }

    /// Runs `task` unless the user cancels first; the server is asked to
    /// stop by `cancel_query`.
    async fn guarded<T>(
        &self,
        task: impl std::future::Future<Output = Result<T, tokio_postgres::Error>>,
    ) -> Result<T, Failure> {
        let result = tokio::select! {
            r = task => r,
            () = self.token.cancelled() => return Err(Failure::Cancelled),
        };
        result.map_err(|e| {
            let db = DbError::from_pg(&e);
            // The server's cancel error also comes from a statement timeout.
            if db.is_cancel() && self.token.is_cancelled() {
                Failure::Cancelled
            } else {
                Failure::Failed(Box::new(db))
            }
        })
    }

    async fn event(&mut self, event: Event) -> Flow {
        match event {
            Event::Meta { line, text } => {
                let command = text.split_whitespace().next().unwrap_or("\\");
                self.warn(
                    line,
                    format!("Skipped the psql command {command}: only SQL runs here."),
                );
                Flow::Go
            }
            Event::Statement(stmt) => self.statement(stmt).await,
            Event::CopyStart(stmt) => self.copy_start(stmt).await,
            Event::CopyData(data) => self.copy_data(data).await,
            Event::CopyEnd { terminated } => self.copy_end(terminated).await,
        }
    }

    async fn statement(&mut self, stmt: Statement) -> Flow {
        self.statements += 1;
        self.bytes_read = self.bytes_read.max(stmt.end as u64);
        self.progress(&preview(&stmt.text));
        let outcome = self.guarded(drain(self.client, &stmt.text)).await;
        // Nobody reads the notices of a script, and the channel is unbounded.
        self.client.take_notices();
        self.finish(outcome, self.statements, stmt.line)
    }

    fn finish<T>(&mut self, outcome: Result<T, Failure>, index: u64, line: u64) -> Flow {
        match outcome {
            Ok(_) => Flow::Go,
            Err(Failure::Cancelled) => {
                self.cancelled = true;
                Flow::Stop
            }
            Err(Failure::Failed(db)) => self.fail(index, line, &db),
        }
    }

    async fn copy_start(&mut self, stmt: Statement) -> Flow {
        self.statements += 1;
        self.progress(&preview(&stmt.text));
        let index = self.statements;
        let started = self
            .guarded(self.client.client.copy_in::<_, Cursor<Vec<u8>>>(&stmt.text))
            .await;
        match started {
            Ok(sink) => {
                self.copy = Some((index, stmt.line, Box::pin(sink)));
                Flow::Go
            }
            // The data lines that follow are skipped.
            outcome => self.finish(outcome.map(|_| ()), index, stmt.line),
        }
    }

    async fn copy_data(&mut self, data: Vec<u8>) -> Flow {
        let Some((index, line, mut sink)) = self.copy.take() else {
            return Flow::Go;
        };
        let sent = self
            .guarded(async { sink.send(Cursor::new(data)).await })
            .await;
        match sent {
            Ok(()) => {
                self.copy = Some((index, line, sink));
                Flow::Go
            }
            // Dropping the sink aborts the COPY on the server.
            outcome => self.finish(outcome, index, line),
        }
    }

    async fn copy_end(&mut self, terminated: bool) -> Flow {
        let Some((index, line, mut sink)) = self.copy.take() else {
            return Flow::Go;
        };
        if !terminated {
            return self.fail(
                index,
                line,
                &plain_error("The COPY data ends before its \\. line, so it was not loaded."),
            );
        }
        let rows = self.guarded(async { sink.as_mut().finish().await }).await;
        if let Ok(rows) = &rows {
            self.copied_rows += rows;
        }
        self.finish(rows, index, line)
    }
}

fn plain_error(message: &str) -> DbError {
    DbError {
        message: message.to_string(),
        code: None,
        detail: None,
        hint: None,
        position: None,
        severity: None,
    }
}

/// Runs `sql` and drops what it returns: a script is run for its effects.
async fn drain(client: &PgClient, sql: &str) -> Result<(), tokio_postgres::Error> {
    let stream = client.client.simple_query_raw(sql).await?;
    pin_mut!(stream);
    while stream.try_next().await?.is_some() {}
    Ok(())
}

/// The first line of the statement's code, short enough for a status line.
fn preview(text: &str) -> String {
    let mut rest = text.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            break;
        }
    }
    let mut out = String::new();
    let mut chars = 0;
    for word in rest.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
            chars += 1;
        }
        for c in word.chars() {
            if chars == PREVIEW_CHARS {
                out.push('…');
                return out;
            }
            out.push(c);
            chars += 1;
        }
    }
    out
}

/// Runs the file at `path` on `client`. A cancel or an error that stops the
/// run is part of the summary, not a failure of the call.
pub async fn run_file(
    client: &PgClient,
    path: &Path,
    options: &ScriptOptions,
    token: &CancelToken,
    execution_id: &str,
    on_progress: impl FnMut(ScriptProgress),
) -> AppResult<ScriptSummary> {
    let mut file = std::fs::File::open(path)?;
    let total_bytes = file.metadata()?.len();
    let mut run = Run {
        client,
        token,
        execution_id,
        on_progress,
        stop_on_error: options.stop_on_error || options.single_transaction,
        started: Instant::now(),
        last_progress: Instant::now(),
        total_bytes,
        bytes_read: 0,
        statements: 0,
        errors: Vec::new(),
        error_count: 0,
        warnings: Vec::new(),
        warning_count: 0,
        copied_rows: 0,
        cancelled: false,
        stopped: false,
        copy: None,
    };
    if options.single_transaction {
        drain(client, "BEGIN").await?;
    }

    let mut splitter = Splitter::new(SplitterOptions {
        meta_commands: true,
        copy_data: true,
    });
    let mut buf = vec![0u8; CHUNK];
    let mut events = Vec::new();
    let mut fed = 0u64;
    'read: loop {
        if token.is_cancelled() {
            run.cancelled = true;
            break;
        }
        let n = match file.read(&mut buf) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return abort(client, options, e.into()).await,
        };
        if n == 0 {
            splitter.finish(&mut events);
        } else {
            splitter.feed(&buf[..n], &mut events);
        }
        run.bytes_read = run.bytes_read.max(fed);
        fed += n as u64;
        for event in events.drain(..) {
            if run.event(event).await == Flow::Stop {
                break 'read;
            }
        }
        if n == 0 {
            run.bytes_read = total_bytes;
            break;
        }
    }
    // A COPY still open when the run ends is dropped, which aborts it.
    run.copy = None;

    let mut rolled_back = false;
    if options.single_transaction {
        let clean = run.error_count == 0 && !run.cancelled;
        let ended = if clean { "COMMIT" } else { "ROLLBACK" };
        // After a cancel the connection may still be busy; give up on it
        // rather than wait: closing it rolls the transaction back anyway.
        let ended = tokio::time::timeout(Duration::from_secs(10), drain(client, ended)).await;
        match (clean, ended) {
            (true, Ok(Ok(()))) => {}
            (true, Ok(Err(e))) => {
                run.fail(run.statements, 0, &DbError::from_pg(&e));
                rolled_back = true;
            }
            _ => rolled_back = true,
        }
    }
    Ok(ScriptSummary {
        statements: run.statements,
        errors: run.errors,
        error_count: run.error_count,
        warnings: run.warnings,
        warning_count: run.warning_count,
        copied_rows: run.copied_rows,
        bytes_read: run.bytes_read,
        total_bytes,
        elapsed_ms: run.started.elapsed().as_millis() as u64,
        cancelled: run.cancelled,
        stopped: run.stopped,
        rolled_back,
    })
}

/// The file became unreadable halfway: what ran in a single transaction
/// must not be kept.
async fn abort<T>(client: &PgClient, options: &ScriptOptions, error: AppError) -> AppResult<T> {
    if options.single_transaction {
        let _ = drain(client, "ROLLBACK").await;
    }
    Err(error)
}

/// Runs a SQL file on its own connection, streaming it from disk.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_sql_file<R: Runtime>(
    state: State<'_, AppState>,
    app: AppHandle<R>,
    session_id: String,
    database: String,
    path: String,
    options: ScriptOptions,
    execution_id: String,
) -> AppResult<ScriptSummary> {
    let s = logged("run_sql_file", session(&state, &session_id).await)?;
    let settings = &s.target.settings;
    if settings.pooler_mode && settings.read_only {
        // Read-only behind a pooler is enforced by wrapping each statement,
        // which a script's own transaction commands would defeat.
        return logged(
            "run_sql_file",
            Err(AppError::InvalidInput(
                "This connection is read-only behind a pooler, so scripts can't run on it."
                    .to_string(),
            )),
        );
    }
    // Its own connection: a script can run for hours.
    let key = format!("file:{execution_id}");
    let client = logged("run_sql_file", s.pinned(&key, &database).await)?;
    let token = track_task(&state, &execution_id, Some(client.canceller()));
    let started = Instant::now();
    let result = run_file(
        &client,
        Path::new(&path),
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
    // Neither the file's name nor its statements are logged.
    let op = Op::new("sqlFile", &database, None);
    match &result {
        Ok(summary) => log::info!(
            "{op} [{}] ran {} statements ({} errors){} in {} ms",
            s.name,
            summary.statements,
            summary.error_count,
            if summary.cancelled { ", cancelled" } else { "" },
            started.elapsed().as_millis()
        ),
        Err(e) => logging::op_failed(&op, &s.name, started.elapsed(), e),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_skip_comments_and_squeeze_blanks() {
        assert_eq!(
            preview("-- head\n/* x */\n  insert   into\n t values (1)"),
            "insert into t values (1)"
        );
        assert_eq!(preview("-- only a comment"), "");
        let long = format!("select '{}'", "ç".repeat(200));
        let short = preview(&long);
        assert_eq!(short.chars().count(), PREVIEW_CHARS + 1);
        assert!(short.ends_with('…'));
    }

    #[test]
    fn options_default_to_stopping_at_the_first_error() {
        let options: ScriptOptions = serde_json::from_str("{}").unwrap();
        assert!(options.stop_on_error && !options.single_transaction);
        let options: ScriptOptions =
            serde_json::from_str(r#"{"stopOnError": false, "singleTransaction": true}"#).unwrap();
        assert!(!options.stop_on_error && options.single_transaction);
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the dev server (docker-compose.dev.yml). Run with:
    //!   POSTGRES_STUDIO_TEST_URI=postgres://postgres:postgres@localhost:5433/shop \
    //!     cargo test --lib -- --ignored script_file::live_tests
    use super::*;
    use crate::pg::test_support::live_session;
    use std::io::Write;

    const STATEMENTS: usize = 4000;
    const ROWS_PER_INSERT: usize = 40;
    const COPY_ROWS: usize = 50_000;
    /// Statement whose insert repeats an id, so it fails.
    const BAD_STATEMENT: usize = 2000;

    /// A dump-like file of about 20 MB. Returns its path.
    fn generate(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        let mut out = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
        writeln!(out, "--\n-- PostgreSQL database dump\n--\n").unwrap();
        writeln!(out, "\\restrict k3y").unwrap();
        writeln!(out, "SET client_min_messages = warning;").unwrap();
        writeln!(
            out,
            "SELECT pg_catalog.set_config('search_path', '', false);"
        )
        .unwrap();
        writeln!(
            out,
            "CREATE FUNCTION public.agent_scripts_f(x integer) RETURNS integer\n    LANGUAGE plpgsql\n    AS $$\nBEGIN\n  -- not a statement end;\n  RETURN x + 1;\nEND;\n$$;\n"
        )
        .unwrap();
        let filler = "x".repeat(60);
        for i in 0..STATEMENTS {
            write!(out, "INSERT INTO public.agent_scripts_big VALUES ").unwrap();
            for r in 0..ROWS_PER_INSERT {
                let id = i * ROWS_PER_INSERT + r;
                // the failing statement repeats the ids of the first one
                let id = if i == 0 || i != BAD_STATEMENT {
                    id + 1_000_000
                } else {
                    r + 1_000_000
                };
                let sep = if r == 0 { "" } else { ", " };
                write!(
                    out,
                    "{sep}({id}, 'it''s; a \"note\" -- {id}', '{filler}$$')"
                )
                .unwrap();
            }
            writeln!(out, ";").unwrap();
            if i % 500 == 0 {
                writeln!(out, "-- progress; {i}\n/* block; /* nested; */ */").unwrap();
            }
        }
        writeln!(
            out,
            "\nCOPY public.agent_scripts_big (id, note, payload) FROM stdin;"
        )
        .unwrap();
        for i in 0..COPY_ROWS {
            let note = if i % 10 == 0 {
                "\\N".to_string()
            } else {
                format!("tab\\there $$ 'q' -- {i}")
            };
            writeln!(out, "{}\t{note}\t{filler}", 10_000_000 + i).unwrap();
        }
        writeln!(out, "\\.\n").unwrap();
        writeln!(out, "SELECT count(*) FROM public.agent_scripts_big;").unwrap();
        writeln!(out, "\\unrestrict k3y").unwrap();
        out.flush().unwrap();
        path
    }

    async fn reset(client: &PgClient) {
        drain(
            client,
            "DROP FUNCTION IF EXISTS public.agent_scripts_f(integer)",
        )
        .await
        .unwrap();
        drain(
            client,
            "DROP TABLE IF EXISTS public.agent_scripts_big; \
             CREATE TABLE public.agent_scripts_big (id int primary key, note text, payload text)",
        )
        .await
        .unwrap();
    }

    async fn count(client: &PgClient) -> i64 {
        let row = client
            .client
            .query_one("SELECT count(*) FROM public.agent_scripts_big", &[])
            .await
            .unwrap();
        row.get(0)
    }

    async fn function_exists(client: &PgClient) -> bool {
        let row = client
            .client
            .query_one(
                "SELECT to_regproc('public.agent_scripts_f') IS NOT NULL",
                &[],
            )
            .await
            .unwrap();
        row.get(0)
    }

    async fn run(
        client: &PgClient,
        path: &Path,
        stop_on_error: bool,
        single_transaction: bool,
    ) -> ScriptSummary {
        let options = ScriptOptions {
            stop_on_error,
            single_transaction,
        };
        run_file(
            client,
            path,
            &options,
            &CancelToken::default(),
            "test",
            |_| {},
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    #[ignore]
    async fn live_runs_a_large_dump_in_every_mode() {
        let s = live_session().await;
        let client = s.pinned("file:test", "shop").await.unwrap();
        let path = generate("agent_scripts_20mb.sql");
        let size = std::fs::metadata(&path).unwrap().len();
        assert!(size > 18_000_000, "{size}");

        // Continue past the error: everything but the bad statement lands.
        reset(&client).await;
        let started = Instant::now();
        let done = run(&client, &path, false, false).await;
        eprintln!(
            "script of {size} bytes, {} statements: {} ms",
            done.statements,
            started.elapsed().as_millis()
        );
        assert_eq!(done.error_count, 1, "{:?}", done.errors);
        let error = &done.errors[0];
        assert_eq!(error.code.as_deref(), Some("23505"));
        assert!(error.line > 10 && error.index > BAD_STATEMENT as u64);
        assert_eq!(done.copied_rows, COPY_ROWS as u64);
        assert_eq!(done.warning_count, 2, "{:?}", done.warnings);
        assert!(!done.stopped && !done.cancelled && !done.rolled_back);
        assert_eq!(done.bytes_read, size);
        let expected = (STATEMENTS - 1) * ROWS_PER_INSERT + COPY_ROWS;
        assert_eq!(count(&client).await, expected as i64);
        assert!(function_exists(&client).await);
        let nulls: i64 = client
            .client
            .query_one(
                "SELECT count(*) FROM public.agent_scripts_big WHERE note IS NULL",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(nulls, (COPY_ROWS / 10) as i64);
        let tab: String = client
            .client
            .query_one(
                "SELECT note FROM public.agent_scripts_big WHERE id = 10000001",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(tab, "tab\there $$ 'q' -- 1");

        // Stop at the error: what ran before it stays.
        reset(&client).await;
        let done = run(&client, &path, true, false).await;
        assert!(done.stopped && done.error_count == 1);
        let before = (BAD_STATEMENT * ROWS_PER_INSERT) as i64;
        assert_eq!(count(&client).await, before);
        assert_eq!(done.copied_rows, 0);

        // One transaction: the error undoes it all, function included.
        reset(&client).await;
        drain(
            &client,
            "DROP FUNCTION IF EXISTS public.agent_scripts_f(integer)",
        )
        .await
        .unwrap();
        let done = run(&client, &path, false, true).await;
        assert!(done.stopped && done.rolled_back && done.error_count == 1);
        assert_eq!(count(&client).await, 0);
        assert!(!function_exists(&client).await);

        // One transaction without an error commits.
        let clean = std::env::temp_dir().join("agent_scripts_clean.sql");
        std::fs::write(
            &clean,
            "INSERT INTO public.agent_scripts_big VALUES (1, 'a', 'b'), (2, NULL, 'c');\n\
             COPY public.agent_scripts_big FROM stdin;\n3\td\te\n\\.\nSELECT 1",
        )
        .unwrap();
        let done = run(&client, &clean, true, true).await;
        assert_eq!(done.error_count, 0, "{:?}", done.errors);
        assert!(!done.rolled_back);
        assert_eq!(done.statements, 3);
        assert_eq!(count(&client).await, 3);

        // A COPY that cuts off before its terminator is not loaded.
        std::fs::write(
            &clean,
            "COPY public.agent_scripts_big FROM stdin;\n9\tx\ty\n",
        )
        .unwrap();
        let done = run(&client, &clean, false, false).await;
        assert_eq!(done.error_count, 1);
        assert_eq!(count(&client).await, 3);

        // A COPY that fails mid-data leaves the connection usable.
        std::fs::write(
            &clean,
            "COPY public.agent_scripts_big FROM stdin;\n10\tx\ty\nnot-a-number\tx\ty\n\\.\nINSERT INTO public.agent_scripts_big VALUES (11, 'k', 'k')",
        )
        .unwrap();
        let done = run(&client, &clean, false, false).await;
        assert_eq!(done.error_count, 1, "{:?}", done.errors);
        assert!(done.errors[0].message.contains("integer"));
        assert_eq!(count(&client).await, 4);

        drain(&client, "DROP TABLE public.agent_scripts_big")
            .await
            .unwrap();
        drain(
            &client,
            "DROP FUNCTION IF EXISTS public.agent_scripts_f(integer)",
        )
        .await
        .unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&clean);
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_cancelling_stops_a_running_script() {
        let s = live_session().await;
        let client = s.pinned("file:cancel", "shop").await.unwrap();
        let path = std::env::temp_dir().join("agent_scripts_cancel.sql");
        std::fs::write(&path, "SELECT 1;\nSELECT pg_sleep(30);\nSELECT 2;").unwrap();
        let token = CancelToken::default();
        let canceller = client.canceller();
        let stopper = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            canceller.cancel().await;
            stopper.cancel();
        });
        let started = Instant::now();
        let done = run_file(
            &client,
            &path,
            &ScriptOptions::default(),
            &token,
            "cancel",
            |_| {},
        )
        .await
        .unwrap();
        assert!(done.cancelled);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(done.statements, 2);
        assert_eq!(done.error_count, 0);
        let _ = std::fs::remove_file(&path);
        s.shutdown().await;
    }
}
