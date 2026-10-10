//! The MCP tools: read-only views of the session's database.
//!
//! Every call is bound to the database of the session whose token made it,
//! checks the policy the frontend set (connection shared, plans and indexes
//! shared, row values allowed), and reports itself to the windows as an
//! `assistant-step` when it starts and when it ends. Tools that return row
//! values ask the user first unless the policy already allows it.
//!
//! Nothing here can write: the agent's SQL must be one SELECT-like
//! statement, and it runs inside `BEGIN READ ONLY ... ROLLBACK` on a
//! connection of the Assistant's own, with a statement timeout. Functions
//! that act on the server without writing data (ending other sessions,
//! reading server files) are refused by name.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{pin_mut, TryStreamExt};
use serde_json::{json, Value};
use tokio::sync::oneshot;
use tokio_postgres::SimpleQueryMessage;
use uuid::Uuid;

use super::{
    AgentSession, ApprovalChoice, ApprovalEvent, Inner, PendingApproval, StepEvent, StepState,
    APPROVAL_EVENT, STEP_EVENT,
};
use crate::pg::catalog::{self, json_query};
use crate::pg::{literal, qualified, run, split, PgClient};

/// Server-side limit on every statement.
const STATEMENT_TIMEOUT: &str = "15s";
/// Client-side backstop.
const OP_TIMEOUT: Duration = Duration::from_secs(20);
/// Tool output is cut here, to keep the agent's context small.
const MAX_OUTPUT: usize = 20 * 1024;
const MAX_META: usize = 120;
/// dry_run counts up to this many rows, then says "1,000+".
const DRY_RUN_CAP: usize = 1000;

const REFUSED_PLANS: &str = "Indexes and query plans aren't shared with the Assistant.";
const REFUSED_CONNECTION: &str = "This connection isn't shared with the Assistant.";
const DENIED_VALUES: &str =
    "The user declined to share row values. Work from table and column names and types, or ask them.";

/// Functions that touch the server rather than data, which a read-only
/// transaction still allows.
const DENIED_FUNCTIONS: [&str; 16] = [
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_read_file",
    "pg_read_binary_file",
    "pg_ls_dir",
    "pg_stat_file",
    "lo_import",
    "lo_export",
    "lo_get",
    "dblink",
    "set_config",
    "pg_promote",
    "pg_switch_wal",
    "pg_create_restore_point",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tool {
    ListTables,
    DescribeTable,
    Explain,
    Count,
    DryRun,
    Query,
}

impl Tool {
    fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "list_tables" => Tool::ListTables,
            "describe_table" => Tool::DescribeTable,
            "explain" => Tool::Explain,
            "count" => Tool::Count,
            "dry_run" => Tool::DryRun,
            "query" => Tool::Query,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Tool::ListTables => "list_tables",
            Tool::DescribeTable => "describe_table",
            Tool::Explain => "explain",
            Tool::Count => "count",
            Tool::DryRun => "dry_run",
            Tool::Query => "query",
        }
    }

    /// Labels for a running, finished and failed step on `target`.
    fn labels(self, target: &str) -> (String, String, String) {
        let (run, ok, fail) = match self {
            Tool::ListTables => (
                "Listing tables in",
                "Listed tables in",
                "Couldn't list tables in",
            ),
            Tool::DescribeTable => (
                "Reading the structure of",
                "Read the structure of",
                "Couldn't read the structure of",
            ),
            Tool::Explain => (
                "Explaining a query on",
                "Explained a query on",
                "Couldn't explain a query on",
            ),
            Tool::Count => (
                "Counting rows in",
                "Counted rows in",
                "Couldn't count rows in",
            ),
            Tool::DryRun => (
                "Dry-running a query on",
                "Dry-ran a query on",
                "Couldn't dry-run a query on",
            ),
            Tool::Query => (
                "Reading rows from",
                "Read rows from",
                "Couldn't read rows from",
            ),
        };
        (
            format!("{run} {target}"),
            format!("{ok} {target}"),
            format!("{fail} {target}"),
        )
    }
}

/// The `tools/list` result.
pub(crate) fn definitions() -> Value {
    let table = json!({ "type": "string", "description": "Table or view, as schema.table or just table (public first)." });
    let sql = json!({ "type": "string", "description": "One SELECT (or WITH ... SELECT, VALUES, TABLE, SHOW) statement, no trailing semicolon needed." });
    let read_only =
        json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false });
    json!([
        {
            "name": "list_tables",
            "description": "Lists the tables, views and materialized views of the database (user schemas), with approximate row counts.",
            "inputSchema": { "type": "object", "properties": { "schema": { "type": "string", "description": "Only this schema." } } },
            "annotations": read_only,
        },
        {
            "name": "describe_table",
            "description": "A table's columns with types, nullability and defaults, its primary key, foreign keys in both directions, check constraints and (if shared) indexes. No row values.",
            "inputSchema": { "type": "object", "properties": { "table": table }, "required": ["table"] },
            "annotations": read_only,
        },
        {
            "name": "explain",
            "description": "EXPLAIN (without ANALYZE: nothing runs) for one statement: the plan with costs and estimated rows.",
            "inputSchema": { "type": "object", "properties": { "sql": sql }, "required": ["sql"] },
            "annotations": read_only,
        },
        {
            "name": "count",
            "description": "Counts the rows of a table, optionally matching a WHERE condition.",
            "inputSchema": { "type": "object", "properties": {
                "table": table,
                "where": { "type": "string", "description": "A SQL condition, without the WHERE keyword." },
            }, "required": ["table"] },
            "annotations": read_only,
        },
        {
            "name": "dry_run",
            "description": "Runs a query read-only and reports whether it works, how many rows it returns (up to 1,000), its columns and types, and how long it took. No row values.",
            "inputSchema": { "type": "object", "properties": { "sql": sql }, "required": ["sql"] },
            "annotations": read_only,
        },
        {
            "name": "query",
            "description": "Runs a query read-only and returns its rows as JSON lines. Returns row values, so it may ask the user first; use it only when names and types are not enough.",
            "inputSchema": { "type": "object", "properties": {
                "sql": sql,
                "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 },
            }, "required": ["sql"] },
            "annotations": read_only,
        },
    ])
}

/// What `initialize` tells the agent about this server.
pub(crate) const INSTRUCTIONS: &str = "Read-only access to one PostgreSQL database in Postgres Studio. \
list_tables lists what is there; describe_table gives a table's columns, types and keys (no values); \
explain shows a plan without running it; count counts rows; dry_run runs a query and reports its row \
count and columns; query returns row values and may ask the user first. Everything runs in a \
read-only transaction: nothing can write.";

pub(crate) struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

impl ToolOutput {
    fn ok(text: String) -> Self {
        Self {
            text: truncate(text, MAX_OUTPUT),
            is_error: false,
        }
    }

    fn error(text: impl Into<String>) -> Self {
        Self {
            text: truncate(text.into(), MAX_OUTPUT),
            is_error: true,
        }
    }
}

/// A successful operation: text for the agent, and the step's final label
/// (when it depends on the result) and meta.
struct Done {
    text: String,
    label: Option<String>,
    meta: String,
}

/// Reports one tool call to the windows.
struct Step<'a> {
    inner: &'a Inner,
    session: &'a AgentSession,
    id: String,
    tool: Tool,
    call: String,
}

impl Step<'_> {
    fn emit(&self, state: StepState, label: &str, meta: &str, out: &str) {
        self.inner.emit(
            STEP_EVENT,
            &StepEvent {
                agent_session_id: self.session.id.clone(),
                step_id: self.id.clone(),
                tool: self.tool.name().to_string(),
                state,
                label: label.to_string(),
                meta: truncate(meta.to_string(), MAX_META),
                call: self.call.clone(),
                out: truncate(out.to_string(), 200),
            },
        );
    }
}

/// Runs a `tools/call`. `None` when there's no tool by that name.
pub(crate) async fn call(
    inner: &Arc<Inner>,
    session: &Arc<AgentSession>,
    name: &str,
    args: Value,
) -> Option<ToolOutput> {
    let tool = Tool::from_name(name)?;
    let args = match args {
        Value::Object(map) => Value::Object(map),
        _ => json!({}),
    };
    let step = Step {
        inner,
        session,
        id: Uuid::new_v4().to_string(),
        tool,
        call: truncate(format!("{}({})", tool.name(), args), 2000),
    };

    let db = session.database.as_str();
    let table = match tool {
        Tool::DescribeTable | Tool::Count => {
            match str_arg(&args, "table").or(session.table.clone()) {
                Some(t) => Some(t),
                None => {
                    let (_, _, fail) = tool.labels(db);
                    step.emit(StepState::Error, &fail, "table is required", "");
                    return Some(ToolOutput::error("The table argument is required."));
                }
            }
        }
        _ => None,
    };
    let target = match &table {
        Some(t) => format!("{db}.{t}"),
        None => db.to_string(),
    };
    let (run_label, ok_label, fail_label) = tool.labels(&target);

    let policy = inner.policy();
    if !policy.allowed_connections.contains(&session.connection_id) {
        step.emit(
            StepState::Denied,
            &run_label,
            "not shared with the Assistant",
            "",
        );
        return Some(ToolOutput::error(REFUSED_CONNECTION));
    }
    if tool == Tool::Explain && !policy.indexes {
        step.emit(
            StepState::Denied,
            &run_label,
            "not shared with the Assistant",
            "",
        );
        return Some(ToolOutput::error(REFUSED_PLANS));
    }

    step.emit(StepState::Run, &run_label, "", "");

    let limit = match tool {
        Tool::Query => int_arg(&args, "limit", 20, 50),
        _ => 0,
    };
    let grant = if tool == Tool::Query {
        match request_values(inner, session, tool, table.as_deref(), limit).await {
            Some(grant) => Some(grant),
            None => {
                step.emit(StepState::Denied, "Reading row values", "denied by you", "");
                return Some(ToolOutput::error(DENIED_VALUES));
            }
        }
    } else {
        None
    };

    let Some(client) = inner
        .host
        .client(session.app_session_id.clone(), session.database.clone())
        .await
    else {
        let message = "The connection to the database was closed.";
        step.emit(StepState::Error, &fail_label, message, "");
        return Some(ToolOutput::error(message));
    };

    let result = tokio::time::timeout(
        OP_TIMEOUT,
        run(
            tool,
            &client,
            &target,
            table.as_deref(),
            &args,
            limit,
            grant,
            policy.indexes,
        ),
    )
    .await
    .unwrap_or_else(|_| Err("The operation timed out.".to_string()));

    Some(match result {
        Ok(done) => {
            let out = done.text.lines().next().unwrap_or_default().to_string();
            step.emit(
                StepState::Ok,
                done.label.as_deref().unwrap_or(&ok_label),
                &done.meta,
                &out,
            );
            ToolOutput::ok(done.text)
        }
        Err(message) => {
            step.emit(StepState::Error, &fail_label, &message, "");
            ToolOutput::error(message)
        }
    })
}

/// Whether the tool may return row values: `Some(meta)` describing why, or
/// `None` when the user declined.
async fn request_values(
    inner: &Arc<Inner>,
    session: &Arc<AgentSession>,
    tool: Tool,
    table: Option<&str>,
    limit: i64,
) -> Option<String> {
    let policy = inner.policy();
    if policy.values {
        return Some("row values on".to_string());
    }
    let always = format!("always allowed on {}", session.connection_name);
    if policy.values_connections.contains(&session.connection_id) {
        return Some(always);
    }
    if !inner.is_live(session) {
        return None;
    }
    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    inner.approvals.lock().unwrap().insert(
        request_id.clone(),
        PendingApproval {
            agent_session_id: session.id.clone(),
            tx,
        },
    );
    inner.emit(
        APPROVAL_EVENT,
        &ApprovalEvent {
            agent_session_id: session.id.clone(),
            request_id,
            tool: tool.name().to_string(),
            database: session.database.clone(),
            table: table.map(str::to_string),
            limit: Some(limit),
            provider: session.agent.provider().to_string(),
        },
    );
    match rx.await {
        Ok(ApprovalChoice::Once) => Some("allowed once".to_string()),
        Ok(ApprovalChoice::Always) => Some(always),
        Ok(ApprovalChoice::Deny) | Err(_) => None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run(
    tool: Tool,
    client: &PgClient,
    target: &str,
    table: Option<&str>,
    args: &Value,
    limit: i64,
    grant: Option<String>,
    indexes: bool,
) -> Result<Done, String> {
    match tool {
        Tool::ListTables => list_tables(client, str_arg(args, "schema").as_deref()).await,
        Tool::DescribeTable => {
            let (schema, name) = resolve(client, table.unwrap_or_default()).await?;
            let info = catalog::describe_table(client, &schema, &name)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Done {
                text: describe(&info, indexes),
                label: Some(format!("Read the structure of {schema}.{name}")),
                meta: plural(info.columns.len() as u64, "column", "columns"),
            })
        }
        Tool::Explain => {
            let sql = agent_sql(&str_arg(args, "sql").unwrap_or_default())?;
            let rows = read_only(client, &format!("EXPLAIN {sql}"), usize::MAX).await?;
            let plan: Vec<String> = rows
                .rows
                .into_iter()
                .filter_map(|r| r.into_iter().next().flatten())
                .collect();
            let meta = plan
                .first()
                .map(|l| l.split("  (").next().unwrap_or(l).trim().to_string())
                .unwrap_or_default();
            Ok(Done {
                text: format!("Plan on {target}:\n{}", plan.join("\n")),
                label: None,
                meta,
            })
        }
        Tool::Count => {
            let (schema, name) = resolve(client, table.unwrap_or_default()).await?;
            let mut sql = format!("SELECT count(*) FROM {}", qualified(&schema, &name));
            if let Some(w) = str_arg(args, "where").filter(|w| !w.trim().is_empty()) {
                sql.push_str(&format!(" WHERE ({w}\n)"));
            }
            let sql = agent_sql(&sql)?;
            let rows = read_only(client, &sql, 1).await?;
            let n: u64 = rows
                .rows
                .first()
                .and_then(|r| r.first().cloned().flatten())
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let text = plural(n, "row", "rows");
            Ok(Done {
                text: format!("{text} in {schema}.{name} match."),
                label: Some(format!("Counted rows in {schema}.{name}")),
                meta: text,
            })
        }
        Tool::DryRun => {
            let sql = agent_sql(&str_arg(args, "sql").unwrap_or_default())?;
            let started = Instant::now();
            let rows = read_only(client, &sql, 0).await?;
            let ms = started.elapsed().as_millis();
            let count = if rows.total > DRY_RUN_CAP as u64 {
                format!("{}+ rows", thousands(DRY_RUN_CAP as u64))
            } else {
                plural(rows.total, "row", "rows")
            };
            Ok(Done {
                text: format!(
                    "The query ran in {ms} ms and returned {count}.\nColumns: {}",
                    rows.columns.join(", ")
                ),
                label: None,
                meta: format!("{count} · {ms} ms"),
            })
        }
        Tool::Query => {
            let sql = agent_sql(&str_arg(args, "sql").unwrap_or_default())?;
            let rows = read_only(client, &sql, limit as usize).await?;
            let lines: Vec<String> = rows
                .rows
                .iter()
                .map(|r| {
                    let object: serde_json::Map<String, Value> = rows
                        .columns
                        .iter()
                        .zip(r)
                        .map(|(c, v)| {
                            (
                                c.clone(),
                                v.clone().map(Value::String).unwrap_or(Value::Null),
                            )
                        })
                        .collect();
                    Value::Object(object).to_string()
                })
                .collect();
            let label = format!(
                "Read {} from {target}",
                plural(rows.rows.len() as u64, "row", "rows")
            );
            Ok(Done {
                text: format!(
                    "{label} (values as text, one JSON object per line):\n{}",
                    lines.join("\n")
                ),
                label: Some(label),
                meta: grant.unwrap_or_default(),
            })
        }
    }
}

/// The agent's SQL, if it's one read-like statement calling nothing that
/// acts on the server.
pub(crate) fn agent_sql(sql: &str) -> Result<String, String> {
    let statements = split::split(sql);
    let [stmt] = statements.as_slice() else {
        return Err("Send exactly one statement.".to_string());
    };
    let command = run::command_of(&stmt.text);
    if !matches!(
        command.as_str(),
        "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW"
    ) {
        return Err(format!("Only read statements run here, not {command}."));
    }
    let lower = stmt.text.to_ascii_lowercase();
    if let Some(f) = DENIED_FUNCTIONS.iter().find(|f| {
        lower.match_indices(*f).any(|(at, _)| {
            let before = lower[..at].chars().next_back();
            !before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    }) {
        return Err(format!(
            "{f} acts on the server and isn't available to the Assistant."
        ));
    }
    Ok(stmt.text.clone())
}

struct ReadRows {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    total: u64,
}

/// Runs `sql` in a read-only transaction that is always rolled back,
/// keeping at most `keep` rows (and counting up to the dry-run cap).
async fn read_only(client: &PgClient, sql: &str, keep: usize) -> Result<ReadRows, String> {
    let batch = format!(
        "BEGIN READ ONLY;\nSET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}';\nSET LOCAL lock_timeout = '2s';\n{sql};\nROLLBACK"
    );
    let result = async {
        let stream = client.client.simple_query_raw(&batch).await?;
        pin_mut!(stream);
        let mut out = ReadRows {
            columns: Vec::new(),
            rows: Vec::new(),
            total: 0,
        };
        while let Some(message) = stream.try_next().await? {
            match message {
                SimpleQueryMessage::RowDescription(cols) => {
                    out.columns = cols.iter().map(|c| c.name().to_string()).collect();
                }
                SimpleQueryMessage::Row(row) => {
                    out.total += 1;
                    if out.rows.len() < keep {
                        out.rows.push(
                            (0..row.len())
                                .map(|i| row.get(i).map(str::to_string))
                                .collect(),
                        );
                    }
                }
                _ => {}
            }
        }
        Ok::<_, tokio_postgres::Error>(out)
    }
    .await;
    match result {
        Ok(rows) => Ok(rows),
        Err(e) => {
            let _ = client.client.simple_query("ROLLBACK").await;
            Err(crate::pg::DbError::from_pg(&e).to_string())
        }
    }
}

/// `schema.table` or `table` to the schema and name it means.
async fn resolve(client: &PgClient, table: &str) -> Result<(String, String), String> {
    let (schema, name) = match table.split_once('.') {
        Some((s, n)) => (Some(s.trim_matches('"')), n.trim_matches('"')),
        None => (None, table.trim_matches('"')),
    };
    let sql = format!(
        "SELECT json_agg(n.nspname ORDER BY n.nspname <> 'public', n.nspname)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = {} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') {}",
        literal(name),
        schema
            .map(|s| format!("AND n.nspname = {}", literal(s)))
            .unwrap_or_default()
    );
    let found: Option<Vec<String>> = json_query(client, &sql).await.map_err(|e| e.to_string())?;
    match found.and_then(|f| f.into_iter().next()) {
        Some(schema) => Ok((schema, name.to_string())),
        None => Err(format!(
            "There is no table or view named {table}. Use list_tables."
        )),
    }
}

async fn list_tables(client: &PgClient, schema: Option<&str>) -> Result<Done, String> {
    let filter = schema
        .map(|s| format!("AND n.nspname = {}", literal(s)))
        .unwrap_or_else(|| "AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'".to_string());
    let sql = format!(
        "SELECT coalesce(json_agg(json_build_array(n.nspname, c.relname, c.relkind,
                CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END)
                ORDER BY n.nspname, c.relname), '[]')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition {filter}"
    );
    let rows: Vec<(String, String, String, Option<i64>)> = json_query(client, &sql)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let lines: Vec<String> = rows
        .iter()
        .map(|(s, n, kind, est)| {
            let kind = match kind.as_str() {
                "v" => "view",
                "m" => "materialized view",
                "f" => "foreign table",
                "p" => "partitioned table",
                _ => "table",
            };
            match est {
                Some(e) => format!("{s}.{n} ({kind}, ~{} rows)", thousands((*e).max(0) as u64)),
                None => format!("{s}.{n} ({kind})"),
            }
        })
        .collect();
    let count = plural(rows.len() as u64, "relation", "relations");
    Ok(Done {
        text: format!("{count}:\n{}", lines.join("\n")),
        label: None,
        meta: count,
    })
}

fn describe(info: &catalog::TableInfo, indexes: bool) -> String {
    let mut out = format!(
        "{}.{} ({}{})\nColumns:\n",
        info.schema,
        info.name,
        match info.kind.as_str() {
            "v" => "view",
            "m" => "materialized view",
            _ => "table",
        },
        info.row_estimate
            .map(|e| format!(", ~{} rows", thousands(e.max(0) as u64)))
            .unwrap_or_default()
    );
    let pk: Vec<&String> = info
        .constraints
        .iter()
        .filter(|c| c.kind == "p")
        .flat_map(|c| c.columns.iter().flatten())
        .collect();
    for c in &info.columns {
        out.push_str(&format!("  {} {}", c.name, c.type_name));
        if !c.nullable {
            out.push_str(" NOT NULL");
        }
        if pk.contains(&&c.name) {
            out.push_str(" PRIMARY KEY");
        }
        if let Some(d) = &c.default {
            out.push_str(&format!(" DEFAULT {d}"));
        }
        if let Some(values) = &c.enum_values {
            out.push_str(&format!(" (enum: {})", values.join(", ")));
        }
        out.push('\n');
    }
    let fks: Vec<String> = info
        .constraints
        .iter()
        .filter(|c| c.kind == "f")
        .map(|c| {
            format!(
                "  ({}) -> {}.{}({})",
                c.columns.clone().unwrap_or_default().join(", "),
                c.ref_schema.clone().unwrap_or_default(),
                c.ref_table.clone().unwrap_or_default(),
                c.ref_columns.clone().unwrap_or_default().join(", ")
            )
        })
        .collect();
    if !fks.is_empty() {
        out.push_str(&format!("Foreign keys:\n{}\n", fks.join("\n")));
    }
    if !info.referenced_by.is_empty() {
        out.push_str("Referenced by:\n");
        for r in &info.referenced_by {
            out.push_str(&format!(
                "  {}.{}({})\n",
                r.schema,
                r.table,
                r.columns.join(", ")
            ));
        }
    }
    let checks: Vec<String> = info
        .constraints
        .iter()
        .filter(|c| matches!(c.kind.as_str(), "c" | "u"))
        .map(|c| format!("  {}", c.definition))
        .collect();
    if !checks.is_empty() {
        out.push_str(&format!("Constraints:\n{}\n", checks.join("\n")));
    }
    if indexes && !info.indexes.is_empty() {
        out.push_str("Indexes:\n");
        for i in &info.indexes {
            out.push_str(&format!("  {}\n", i.definition));
        }
    }
    out
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn int_arg(args: &Value, key: &str, default: i64, max: i64) -> i64 {
    let value = args.get(key).and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
    });
    value.unwrap_or(default).clamp(1, max)
}

/// `1234567` -> `1,234,567`.
pub(crate) fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn plural(n: u64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{} {many}", thousands(n))
    }
}

/// Cuts `text` to at most `max` bytes on a character boundary, saying so.
pub(crate) fn truncate(text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let marker = "… (truncated)";
    let mut end = max.saturating_sub(marker.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{marker}", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{inner_with, session, RecordingHost};
    use super::super::AssistantPolicy;
    use super::*;

    #[test]
    fn only_one_read_statement_gets_through() {
        assert!(agent_sql("select * from orders").is_ok());
        assert!(agent_sql("with x as (select 1) select * from x;").is_ok());
        assert!(agent_sql("select 1; select 2").is_err());
        assert!(agent_sql("delete from orders").is_err());
        assert!(agent_sql("commit").is_err());
        assert!(agent_sql("select 1; commit; drop table orders").is_err());
        assert!(agent_sql("select pg_terminate_backend(123)").is_err());
        assert!(agent_sql("SELECT PG_READ_FILE('/etc/passwd')").is_err());
        // a column that merely contains a denied name is fine
        assert!(agent_sql("select my_set_config from t").is_ok());
    }

    #[test]
    fn formats_numbers_and_cuts_output() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(1234567), "1,234,567");
        assert_eq!(plural(1, "row", "rows"), "1 row");
        assert_eq!(plural(1500, "row", "rows"), "1,500 rows");
        let cut = truncate("é".repeat(100), 51);
        assert!(cut.len() <= 51 && cut.ends_with("(truncated)"));
        assert_eq!(int_arg(&json!({ "limit": 500 }), "limit", 20, 50), 50);
        assert_eq!(int_arg(&json!({ "limit": "7" }), "limit", 20, 50), 7);
        assert_eq!(int_arg(&json!({}), "limit", 20, 50), 20);
    }

    fn step_states(host: &RecordingHost) -> Vec<(String, String, String)> {
        host.events_named(STEP_EVENT)
            .iter()
            .map(|e| {
                (
                    e["state"].as_str().unwrap().to_string(),
                    e["label"].as_str().unwrap().to_string(),
                    e["meta"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn policy_refusals_happen_before_touching_the_database() {
        let host = Arc::new(RecordingHost::default());
        let session = session("shop", "c1");
        let inner = inner_with(
            host.clone(),
            &session,
            AssistantPolicy {
                allowed_connections: vec!["c1".into()],
                ..Default::default()
            },
        );
        let out = call(&inner, &session, "explain", json!({ "sql": "select 1" }))
            .await
            .unwrap();
        assert!(out.is_error);
        assert_eq!(out.text, REFUSED_PLANS);
        assert_eq!(
            step_states(&host),
            [(
                "denied".to_string(),
                "Explaining a query on shop".to_string(),
                "not shared with the Assistant".to_string()
            )]
        );

        inner.policy.lock().unwrap().allowed_connections.clear();
        let out = call(&inner, &session, "count", json!({ "table": "orders" }))
            .await
            .unwrap();
        assert_eq!(out.text, REFUSED_CONNECTION);
        assert!(call(&inner, &session, "drop", json!({})).await.is_none());
    }

    #[tokio::test]
    async fn a_denied_value_request_never_reads() {
        let host = Arc::new(RecordingHost::default());
        let session = session("shop", "c1");
        let inner = inner_with(
            host.clone(),
            &session,
            AssistantPolicy {
                allowed_connections: vec!["c1".into()],
                ..Default::default()
            },
        );
        let task = {
            let (inner, session) = (inner.clone(), session.clone());
            tokio::spawn(async move {
                call(
                    &inner,
                    &session,
                    "query",
                    json!({ "sql": "select * from orders", "limit": 5 }),
                )
                .await
                .unwrap()
            })
        };
        let request = loop {
            if let Some(e) = host.events_named(APPROVAL_EVENT).pop() {
                break e;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert_eq!(request["tool"], "query");
        assert_eq!(request["limit"], 5);
        assert_eq!(request["provider"], "Anthropic");
        super::super::Assistant {
            inner: inner.clone(),
        }
        .answer(request["requestId"].as_str().unwrap(), ApprovalChoice::Deny)
        .unwrap();
        let out = task.await.unwrap();
        assert!(out.is_error);
        assert_eq!(out.text, DENIED_VALUES);
        let states = step_states(&host);
        assert_eq!(states[0].0, "run");
        assert_eq!(
            states[1],
            (
                "denied".to_string(),
                "Reading row values".to_string(),
                "denied by you".to_string()
            )
        );
    }
}
