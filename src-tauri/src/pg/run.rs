//! Running SQL: the console's statements, table pages, counts and plans.

use std::time::Instant;

use futures_util::{pin_mut, TryStreamExt};
use serde::{Deserialize, Serialize};
use tokio_postgres::SimpleQueryMessage;

use super::catalog::json_query;
use super::connect::Notice;
use super::split::{self, Statement};
use super::{literal, qualified, DbError, PgClient};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    /// The type as `format_type` writes it; `unknown` when the statement
    /// couldn't be prepared (pooler mode).
    pub type_name: String,
    pub type_oid: u32,
}

/// One statement's outcome.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    pub index: usize,
    /// Character offsets of the statement in the text that was run.
    pub start: usize,
    pub end: usize,
    /// The statement's leading keyword(s), e.g. `SELECT`, `CREATE TABLE`.
    pub command: String,
    /// Whether it returns rows (a SELECT, or a write with RETURNING).
    pub returns_rows: bool,
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows returned or affected, as the server counted them.
    pub row_count: u64,
    /// More rows came back than `rows` keeps.
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub error: Option<DbError>,
}

/// Where a pinned client stands after a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TxState {
    Idle,
    /// Inside BEGIN ... with work to commit or roll back.
    Active,
    /// A statement failed inside a transaction; only ROLLBACK works now.
    Failed,
    /// Not known (pooler mode can't ask).
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRun {
    pub results: Vec<StatementResult>,
    pub notices: Vec<Notice>,
    pub transaction: TxState,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct RunOptions {
    /// Rows kept per statement; the rest are counted, not sent.
    pub row_limit: usize,
    pub pooler_mode: bool,
    /// Wrap each statement in a read-only transaction (read-only
    /// connections behind a pooler, where session settings don't stick).
    pub wrap_read_only: bool,
}

/// Runs every statement in `sql` in order, each on its own (autocommit
/// unless a transaction is open), stopping at the first error. With
/// `caret` (a character offset), only the statement there runs.
pub async fn run_sql(
    client: &PgClient,
    sql: &str,
    options: RunOptions,
    caret: Option<usize>,
) -> SqlRun {
    let started = Instant::now();
    let statements = match caret {
        Some(chars) => {
            let byte = sql.char_indices().nth(chars).map_or(sql.len(), |(i, _)| i);
            split::statement_at(sql, byte).into_iter().collect()
        }
        None => split::split(sql),
    };
    let mut results = Vec::new();
    // Probed once for the cursor path and kept while only cursor queries
    // run (they leave it as it was); anything else makes it unknown again.
    let mut tx = None;
    for (index, stmt) in statements.iter().enumerate() {
        let result = run_statement(client, sql, index, stmt, options, &mut tx).await;
        let failed = result.error.is_some();
        results.push(result);
        if failed {
            break;
        }
    }
    let transaction = if options.pooler_mode {
        TxState::Unknown
    } else {
        transaction_state(client).await
    };
    SqlRun {
        results,
        notices: client.take_notices(),
        transaction,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

async fn run_statement(
    client: &PgClient,
    sql: &str,
    index: usize,
    stmt: &Statement,
    options: RunOptions,
    tx: &mut Option<TxState>,
) -> StatementResult {
    let started = Instant::now();
    let mut result = StatementResult {
        index,
        start: sql[..stmt.start].chars().count(),
        end: sql[..stmt.end].chars().count(),
        command: command_of(&stmt.text),
        returns_rows: false,
        columns: Vec::new(),
        rows: Vec::new(),
        row_count: 0,
        truncated: false,
        elapsed_ms: 0,
        error: None,
    };
    if let Some(reason) = unsupported(&stmt.text) {
        result.error = Some(plain_error(reason));
        return result;
    }
    if options.wrap_read_only && is_transaction_control(&result.command) {
        result.error = Some(plain_error(
            "This connection is read-only behind a pooler, so each statement runs in its own \
             read-only transaction; transaction commands aren't available.",
        ));
        return result;
    }

    // Preparing tells the column types without running anything; a pooler
    // in transaction mode can't keep named statements, so there it's skipped.
    if !options.pooler_mode {
        if let Ok(prepared) = client.client.prepare(&stmt.text).await {
            result.columns = prepared
                .columns()
                .iter()
                .map(|c| ResultColumn {
                    name: c.name().to_string(),
                    type_name: type_label(c.type_()),
                    type_oid: c.type_().oid(),
                })
                .collect();
            result.returns_rows = !result.columns.is_empty();
        }
    }

    // A query that returns rows reads only what is kept, through a cursor,
    // instead of letting the server send every row only to drop the rest.
    if result.returns_rows && cursorable(&stmt.text) {
        match fetch_through_cursor(client, &stmt.text, &mut result, options, tx).await {
            CursorOutcome::Done => {
                result.elapsed_ms = started.elapsed().as_millis() as u64;
                return result;
            }
            CursorOutcome::Failed(db) => {
                result.error = Some(db);
                result.elapsed_ms = started.elapsed().as_millis() as u64;
                return result;
            }
            // The cursor was refused before the query ran: run it plainly,
            // which also reports the error at the right position.
            CursorOutcome::NotStarted => {
                result.rows.clear();
                result.truncated = false;
            }
        }
    }
    *tx = None;

    let text = if options.wrap_read_only {
        format!("BEGIN READ ONLY;\n{};\nCOMMIT", stmt.text)
    } else {
        stmt.text.clone()
    };
    let outcome = collect(
        client,
        &text,
        &mut result,
        options.row_limit,
        options.wrap_read_only,
    )
    .await;
    if let Err(e) = outcome {
        let db = DbError::from_pg(&e);
        if options.wrap_read_only {
            let _ = client.client.simple_query("ROLLBACK").await;
        }
        result.error = Some(db);
    }
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    result
}

async fn collect(
    client: &PgClient,
    text: &str,
    result: &mut StatementResult,
    row_limit: usize,
    wrapped: bool,
) -> Result<(), tokio_postgres::Error> {
    let stream = client.client.simple_query_raw(text).await?;
    pin_mut!(stream);
    // In a wrapped run the first and last completions are BEGIN's and COMMIT's.
    let mut completions = 0;
    while let Some(message) = stream.try_next().await? {
        match message {
            SimpleQueryMessage::RowDescription(cols) => {
                result.returns_rows = true;
                if result.columns.is_empty() {
                    result.columns = cols
                        .iter()
                        .map(|c| ResultColumn {
                            name: c.name().to_string(),
                            type_name: "unknown".to_string(),
                            type_oid: 0,
                        })
                        .collect();
                }
            }
            SimpleQueryMessage::Row(row) => {
                if result.rows.len() < row_limit {
                    result.rows.push(
                        (0..row.len())
                            .map(|i| row.get(i).map(str::to_string))
                            .collect(),
                    );
                } else {
                    result.truncated = true;
                }
            }
            SimpleQueryMessage::CommandComplete(n) => {
                completions += 1;
                if !wrapped || completions == 2 {
                    result.row_count = n;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

enum CursorOutcome {
    Done,
    /// The query ran and failed: a genuine error, reported as it is.
    Failed(DbError),
    /// Nothing ran (the cursor itself was refused).
    NotStarted,
}

const CURSOR: &str = "postgres_studio_rows";

/// Whether a statement can sit behind `DECLARE ... CURSOR FOR`: a plain
/// query (SELECT, VALUES, TABLE, or WITH ... SELECT without data-modifying
/// parts). A mistake here only costs a second try, plainly.
pub(crate) fn cursorable(text: &str) -> bool {
    let body = strip_comments(text);
    let lower = body.to_ascii_lowercase();
    let first = lower
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .find(|w| !w.is_empty())
        .unwrap_or_default();
    match first {
        "select" | "values" | "table" => !has_word(&lower, "into"),
        "with" => !["insert", "update", "delete", "merge", "into"]
            .iter()
            .any(|w| has_word(&lower, w)),
        _ => false,
    }
}

/// `word` as a whole word outside string literals and quoted names.
fn has_word(lower: &str, word: &str) -> bool {
    let mut plain = String::with_capacity(lower.len());
    let mut quote: Option<char> = None;
    for c in lower.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '\'' || c == '"' => quote = Some(c),
            None => plain.push(c),
        }
    }
    plain
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|w| w == word)
}

/// Runs a query through a cursor and fetches one row past the limit, all
/// in one round trip. Outside a transaction it opens and commits its own;
/// inside the user's, it works under a savepoint so a failure doesn't
/// abort theirs.
async fn fetch_through_cursor(
    client: &PgClient,
    query: &str,
    result: &mut StatementResult,
    options: RunOptions,
    tx: &mut Option<TxState>,
) -> CursorOutcome {
    let in_transaction = match options.pooler_mode {
        // A pooler gives each statement its own transaction anyway.
        true => false,
        false => {
            let state = match *tx {
                Some(state) => state,
                None => transaction_state(client).await,
            };
            *tx = Some(state);
            match state {
                TxState::Active => true,
                // Everything fails there until ROLLBACK: let the plain run say so.
                TxState::Failed => return CursorOutcome::NotStarted,
                TxState::Idle | TxState::Unknown => false,
            }
        }
    };
    let query = query.trim_end().trim_end_matches(';');
    let fetch = options.row_limit.saturating_add(1);
    // A newline before each `;`: the query may end in a `--` comment.
    let body = format!(
        "DECLARE {CURSOR} NO SCROLL CURSOR FOR {query}\n;\nFETCH {fetch} FROM {CURSOR};\nCLOSE {CURSOR}"
    );
    let (open, close, undo) = if in_transaction {
        (
            "SAVEPOINT postgres_studio_fetch",
            "RELEASE SAVEPOINT postgres_studio_fetch",
            "ROLLBACK TO SAVEPOINT postgres_studio_fetch; RELEASE SAVEPOINT postgres_studio_fetch",
        )
    } else if options.wrap_read_only {
        ("BEGIN READ ONLY", "COMMIT", "ROLLBACK")
    } else {
        ("BEGIN", "COMMIT", "ROLLBACK")
    };
    let text = format!("{open};\n{body};\n{close}");

    // The query is under way once the opening statement and DECLARE have
    // both completed: an error after that is the query's own, and running it
    // again would repeat whatever it did (and undo a cancel).
    let mut completions = 0;
    let mut started = false;
    let outcome: Result<(), tokio_postgres::Error> = async {
        let stream = client.client.simple_query_raw(&text).await?;
        pin_mut!(stream);
        while let Some(message) = stream.try_next().await? {
            match message {
                SimpleQueryMessage::RowDescription(cols) => {
                    started = true;
                    if result.columns.is_empty() {
                        result.columns = cols
                            .iter()
                            .map(|c| ResultColumn {
                                name: c.name().to_string(),
                                type_name: "unknown".to_string(),
                                type_oid: 0,
                            })
                            .collect();
                    }
                }
                SimpleQueryMessage::Row(row) => {
                    if result.rows.len() < options.row_limit {
                        result.rows.push(
                            (0..row.len())
                                .map(|i| row.get(i).map(str::to_string))
                                .collect(),
                        );
                    } else {
                        result.truncated = true;
                    }
                }
                SimpleQueryMessage::CommandComplete(_) => {
                    completions += 1;
                    if completions >= 2 {
                        started = true;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    .await;

    match outcome {
        Ok(()) => {
            // Rows kept; `truncated` says more exist, not how many.
            result.row_count = result.rows.len() as u64;
            CursorOutcome::Done
        }
        Err(e) => {
            // The transaction this opened is undone either way. Inside the
            // user's, a query that ran and failed leaves it aborted, as it
            // would without the cursor; only a refused cursor is undone.
            if !in_transaction || !started {
                let _ = client.client.batch_execute(undo).await;
            }
            let db = DbError::from_pg(&e);
            if started || db.is_cancel() {
                // Inside the user's transaction the failure aborted it;
                // outside, the one this opened was rolled back.
                if in_transaction {
                    *tx = Some(TxState::Failed);
                }
                CursorOutcome::Failed(db)
            } else {
                CursorOutcome::NotStarted
            }
        }
    }
}

/// Whether the client sits in a transaction block: inside one, `now()`
/// (the transaction's start) differs from the statement's own timestamp;
/// in a failed one, any statement errors with 25P02.
pub async fn transaction_state(client: &PgClient) -> TxState {
    match client
        .client
        .simple_query("SELECT now() = statement_timestamp()")
        .await
    {
        Ok(messages) => {
            let same = messages.iter().find_map(|m| match m {
                SimpleQueryMessage::Row(r) => r.get(0).map(|v| v == "t"),
                _ => None,
            });
            match same {
                Some(true) => TxState::Idle,
                Some(false) => TxState::Active,
                None => TxState::Unknown,
            }
        }
        Err(e) if e.code().map(|c| c.code()) == Some("25P02") => TxState::Failed,
        Err(_) => TxState::Unknown,
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

/// Statements the simple protocol can't carry through this client.
fn unsupported(text: &str) -> Option<&'static str> {
    let lower = strip_comments(text).to_ascii_lowercase();
    if lower.starts_with("copy") && (lower.contains("stdin") || lower.contains("stdout")) {
        return Some(
            "COPY ... FROM STDIN / TO STDOUT streams through psql's own channel and isn't \
             supported in the console. Use COPY with a server file, or the export.",
        );
    }
    None
}

fn strip_comments(text: &str) -> String {
    let mut rest = text.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, r)| r).trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, r)| r).trim_start();
        } else {
            return rest.to_string();
        }
    }
}

/// The leading keyword, or two for DDL (`CREATE INDEX`), upper-cased.
pub fn command_of(text: &str) -> String {
    let body = strip_comments(text);
    let mut words = body
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|w| !w.is_empty());
    let first = words.next().unwrap_or_default().to_ascii_uppercase();
    match first.as_str() {
        "CREATE" | "DROP" | "ALTER" => {
            let mut second = words.next().unwrap_or_default().to_ascii_uppercase();
            // CREATE OR REPLACE FUNCTION, CREATE UNIQUE INDEX, CREATE TEMP TABLE
            while matches!(
                second.as_str(),
                "OR" | "REPLACE" | "UNIQUE" | "TEMP" | "TEMPORARY" | "UNLOGGED" | "MATERIALIZED"
            ) {
                let next = words.next().unwrap_or_default().to_ascii_uppercase();
                if second == "MATERIALIZED" {
                    second = format!("MATERIALIZED {next}");
                    break;
                }
                second = next;
            }
            format!("{first} {second}")
        }
        _ => first,
    }
}

pub fn is_transaction_control(command: &str) -> bool {
    matches!(
        command,
        "BEGIN"
            | "START"
            | "COMMIT"
            | "END"
            | "ROLLBACK"
            | "ABORT"
            | "SAVEPOINT"
            | "RELEASE"
            | "PREPARE"
    )
}

/// A readable name for a column type. The driver knows built-ins by name;
/// for others (enums, domains) it fetched the name when preparing.
fn type_label(ty: &tokio_postgres::types::Type) -> String {
    match ty.name() {
        "int2" => "smallint",
        "int4" => "integer",
        "int8" => "bigint",
        "float4" => "real",
        "float8" => "double precision",
        "bool" => "boolean",
        "varchar" => "character varying",
        "bpchar" => "character",
        "timestamptz" => "timestamp with time zone",
        "timestamp" => "timestamp without time zone",
        "timetz" => "time with time zone",
        "time" => "time without time zone",
        other => {
            if let Some(inner) = other.strip_prefix('_') {
                return format!("{}[]", type_label_name(inner));
            }
            other
        }
    }
    .to_string()
}

fn type_label_name(name: &str) -> String {
    match name {
        "int2" => "smallint",
        "int4" => "integer",
        "int8" => "bigint",
        "float4" => "real",
        "float8" => "double precision",
        "bool" => "boolean",
        "varchar" => "character varying",
        "bpchar" => "character",
        "timestamptz" => "timestamp with time zone",
        "timestamp" => "timestamp without time zone",
        other => other,
    }
    .to_string()
}

// ---------------------------------------------------------------- tables

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseInput {
    pub where_clause: Option<String>,
    pub order_by: Option<String>,
    pub limit: u32,
    pub offset: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseResult {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Another page follows.
    pub has_more: bool,
    pub elapsed_ms: u64,
    pub notices: Vec<Notice>,
}

fn table_sql(schema: &str, table: &str, input: &BrowseInput, select: &str) -> AppResult<String> {
    let mut sql = format!("SELECT {select} FROM {}", qualified(schema, table));
    if let Some(w) = input
        .where_clause
        .as_deref()
        .map(str::trim)
        .filter(|w| !w.is_empty())
    {
        sql.push_str(&format!(" WHERE ({w}\n)"));
    }
    Ok(sql)
}

fn one_statement(sql: &str) -> AppResult<()> {
    if split::split(sql).len() != 1 {
        return Err(AppError::InvalidInput(
            "The WHERE and ORDER BY fields each take one expression, without semicolons."
                .to_string(),
        ));
    }
    Ok(())
}

/// The columns of a table or view, in order.
pub async fn relation_columns(
    client: &PgClient,
    schema: &str,
    table: &str,
) -> AppResult<Vec<ResultColumn>> {
    let sql = format!(
        "SELECT coalesce(json_agg(json_build_object(
            'name', a.attname, 'typeName', format_type(a.atttypid, a.atttypmod), 'typeOid', a.atttypid::int8)
            ORDER BY a.attnum), '[]')
         FROM pg_attribute a
         WHERE a.attrelid = (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                             WHERE n.nspname = {} AND c.relname = {})
           AND a.attnum > 0 AND NOT a.attisdropped",
        literal(schema),
        literal(table)
    );
    Ok(json_query(client, &sql).await?.unwrap_or_default())
}

/// One page of a table, filtered and sorted as the query bar says.
pub async fn browse(
    client: &PgClient,
    schema: &str,
    table: &str,
    input: &BrowseInput,
) -> AppResult<BrowseResult> {
    let started = Instant::now();
    let mut sql = table_sql(schema, table, input, "*")?;
    if let Some(o) = input
        .order_by
        .as_deref()
        .map(str::trim)
        .filter(|o| !o.is_empty())
    {
        sql.push_str(&format!(" ORDER BY {o}\n"));
    }
    let limit = input.limit.clamp(1, 100_000) as u64;
    sql.push_str(&format!(" LIMIT {} OFFSET {}", limit + 1, input.offset));
    one_statement(&sql)?;

    let (columns, messages) = tokio::join!(
        relation_columns(client, schema, table),
        client.client.simple_query(&sql)
    );
    let columns = columns?;
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    for m in messages? {
        if let SimpleQueryMessage::Row(r) = m {
            rows.push((0..r.len()).map(|i| r.get(i).map(str::to_string)).collect());
        }
    }
    let has_more = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    Ok(BrowseResult {
        columns,
        rows,
        has_more,
        elapsed_ms: started.elapsed().as_millis() as u64,
        notices: client.take_notices(),
    })
}

/// Exact count of the rows the filter matches.
pub async fn count(
    client: &PgClient,
    schema: &str,
    table: &str,
    where_clause: Option<&str>,
) -> AppResult<i64> {
    let input = BrowseInput {
        where_clause: where_clause.map(str::to_string),
        ..Default::default()
    };
    let sql = table_sql(schema, table, &input, "count(*)")?;
    one_statement(&sql)?;
    let messages = client.client.simple_query(&sql).await?;
    messages
        .iter()
        .find_map(|m| match m {
            SimpleQueryMessage::Row(r) => r.get(0).and_then(|v| v.parse().ok()),
            _ => None,
        })
        .ok_or_else(|| AppError::InvalidInput("count returned nothing".to_string()))
}

// ---------------------------------------------------------------- explain

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainResult {
    /// `EXPLAIN (FORMAT JSON)`'s output: an array with one plan object.
    pub plan: serde_json::Value,
    pub analyzed: bool,
    pub elapsed_ms: u64,
}

/// Explains one statement. With `analyze` the statement runs, inside a
/// transaction that is rolled back, so even a write changes nothing.
pub async fn explain(
    client: &PgClient,
    statement: &str,
    analyze: bool,
) -> AppResult<ExplainResult> {
    let started = Instant::now();
    let stmts = split::split(statement);
    let [stmt] = stmts.as_slice() else {
        return Err(AppError::InvalidInput(
            "Explain takes exactly one statement.".to_string(),
        ));
    };
    let options = if analyze {
        "ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON"
    } else {
        "VERBOSE, SETTINGS, FORMAT JSON"
    };
    let sql = if analyze {
        format!("BEGIN;\nEXPLAIN ({options}) {};\nROLLBACK", stmt.text)
    } else {
        format!("EXPLAIN ({options}) {}", stmt.text)
    };
    let result = client.client.simple_query(&sql).await;
    let messages = match result {
        Ok(m) => m,
        Err(e) => {
            if analyze {
                let _ = client.client.simple_query("ROLLBACK").await;
            }
            return Err(e.into());
        }
    };
    let text: String = messages
        .iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::Row(r) => r.get(0).map(str::to_string),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let plan = serde_json::from_str(&text)
        .map_err(|e| AppError::InvalidInput(format!("unexpected EXPLAIN output: {e}")))?;
    Ok(ExplainResult {
        plan,
        analyzed: analyze,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {

    #[test]
    fn knows_which_statements_a_cursor_can_hold() {
        for q in [
            "select * from orders",
            "  -- leading comment\nSELECT 1",
            "with t as (select 1) select * from t",
            "values (1), (2)",
            "table orders",
            "select 'insert into' as label",
        ] {
            assert!(cursorable(q), "{q}");
        }
        for q in [
            "insert into t values (1) returning *",
            "select * into newtable from orders",
            "with gone as (delete from t returning *) select * from gone",
            "explain select 1",
            "show work_mem",
            "update t set a = 1 returning a",
        ] {
            assert!(!cursorable(q), "{q}");
        }
    }

    use super::*;

    #[test]
    fn names_the_command() {
        assert_eq!(command_of("select 1"), "SELECT");
        assert_eq!(command_of("-- note\n  update t set a = 1"), "UPDATE");
        assert_eq!(
            command_of("/* x */ create unique index i on t (a)"),
            "CREATE INDEX"
        );
        assert_eq!(
            command_of("CREATE OR REPLACE FUNCTION f()"),
            "CREATE FUNCTION"
        );
        assert_eq!(
            command_of("create materialized view v as select 1"),
            "CREATE MATERIALIZED VIEW"
        );
        assert_eq!(command_of("drop table t"), "DROP TABLE");
        assert!(is_transaction_control(&command_of("begin")));
        assert!(!is_transaction_control(&command_of("select 1")));
    }

    #[test]
    fn copy_through_stdin_is_refused() {
        assert!(unsupported("COPY t FROM STDIN").is_some());
        assert!(unsupported("-- x\ncopy (select 1) to stdout").is_some());
        assert!(unsupported("copy t from '/tmp/x.csv'").is_none());
    }

    #[test]
    fn filters_must_stay_one_statement() {
        let input = BrowseInput {
            where_clause: Some("id = 1; drop table t".to_string()),
            ..Default::default()
        };
        let sql = table_sql("public", "t", &input, "*").unwrap();
        assert!(one_statement(&sql).is_err());
        let ok = BrowseInput {
            where_clause: Some("note = 'a;b' -- trailing comment".to_string()),
            ..Default::default()
        };
        // the closing parenthesis sits on its own line, after any comment
        let sql = table_sql("public", "t", &ok, "*").unwrap();
        assert!(one_statement(&sql).is_ok(), "{sql}");
    }

    #[test]
    fn labels_types_readably() {
        use tokio_postgres::types::Type;
        assert_eq!(type_label(&Type::INT8), "bigint");
        assert_eq!(type_label(&Type::TEXT_ARRAY), "text[]");
        assert_eq!(type_label(&Type::JSONB), "jsonb");
    }
}
