//! The tools: browse, read and change the databases of the user's saved
//! connections, edit the saved connections themselves, and save scripts.
//!
//! Every call goes the same way: its capability and the connection's level
//! are checked against the user's settings (`policy::decide`); a call that
//! changes rows first runs once in a transaction that is rolled back (the
//! dry run), whose count goes on the approval card when the user wants to
//! be asked, and into the result; then the call runs on the server's own
//! connection to that saved connection. Reads run in a read-only
//! transaction that is always rolled back, whatever the statement says.
//! Every call is reported to the windows as an `mcp-activity` event. Logs
//! name the tool, connection and database, never SQL or rows.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{pin_mut, TryStreamExt};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio_postgres::SimpleQueryMessage;

mod many;

use super::history::{self, HistoryEntry, HistoryFilter};
use super::policy::{self, Answer, Cap, Decision, Request};
use super::tasks::{self, Phase, Task};
use super::{
    now_ms, ClientSession, Inner, Level, McpConfig, Policy, ACTIVITY_EVENT, CONNECTION_EVENT,
};
use crate::assistant::{
    agent_sql, denied_function, describe, int_arg, plural, read_only_with, resolve, str_arg,
    tables_listing, thousands, truncate,
};
use crate::connection::extract_uri_credentials;
use crate::error::{AppError, AppResult};
use crate::logging::{self, Detail};
use crate::models::{ConnectionProfile, ConnectionSource, Environment, DEFAULT_PORT};
use crate::pg::{catalog, run, split, DbError, PgClient, PgSession};

/// Server-side limit on reads, writes and dry runs, unless the call
/// passes timeout_ms (up to `MAX_STATEMENT_MS`).
const DEFAULT_STATEMENT_MS: i64 = 30_000;
const MAX_STATEMENT_MS: i64 = 600_000;
/// Client-side backstop for one operation, past its statement timeout
/// (scripts have their own timeout).
const OP_MARGIN: Duration = Duration::from_secs(30);
/// Tool output is cut here.
const MAX_OUTPUT: usize = 100 * 1024;
/// The approval card's code is cut here.
const MAX_CODE: usize = 8 * 1024;
const MAX_META: usize = 120;
const DEFAULT_ROWS: i64 = 50;
const MAX_ROWS: i64 = 200;
/// Rows of each result a script shows, and RETURNING rows a write shows.
const SHOWN_ROWS: usize = 50;
const DEFAULT_SCRIPT_MS: i64 = 60_000;
const MAX_SCRIPT_MS: i64 = 600_000;
const DEFAULT_HISTORY: i64 = 20;
const MAX_HISTORY: i64 = 200;
const DEFAULT_TASK_WAIT_MS: i64 = 30_000;
/// Under the minute many clients wait for a request.
const MAX_TASK_WAIT_MS: i64 = 45_000;

/// What `execute` takes: statements that change rows.
const WRITE_COMMANDS: [&str; 5] = ["INSERT", "UPDATE", "DELETE", "MERGE", "WITH"];
/// What a read-only script may hold.
const READ_COMMANDS: [&str; 6] = ["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN"];

/// How run_script runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScriptMode {
    /// Each statement commits on its own, unless the script opens a
    /// transaction.
    Normal,
    /// Only reads, in one read-only transaction that is rolled back.
    ReadOnly,
    /// Everything in one transaction that is rolled back.
    DryRun,
}

impl ScriptMode {
    fn of(args: &Value) -> AppResult<Self> {
        match (bool_arg(args, "read_only"), bool_arg(args, "dry_run")) {
            (true, true) => Err(invalid(
                "Pass read_only or dry_run, not both: a read-only script changes nothing anyway.",
            )),
            (true, false) => Ok(Self::ReadOnly),
            (false, true) => Ok(Self::DryRun),
            (false, false) => Ok(Self::Normal),
        }
    }

    /// Whether running it again would repeat a change.
    fn changes_data(self) -> bool {
        self == Self::Normal
    }
}

/// What `run_ddl` takes: statements that change the schema and its grants.
const DDL_COMMANDS: [&str; 11] = [
    "CREATE", "ALTER", "DROP", "TRUNCATE", "COMMENT", "GRANT", "REVOKE", "REINDEX", "REFRESH",
    "ANALYZE", "VACUUM",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tool {
    ListConnections,
    ListDatabases,
    ListSchemas,
    ListTables,
    DescribeTable,
    Query,
    Explain,
    Execute,
    RunDdl,
    RunScript,
    RunScriptOnConnections,
    CreateConnection,
    UpdateConnection,
    DeleteConnection,
    SaveScript,
    GetHistory,
    GetTask,
    CancelTask,
}

/// What a tool works on, and so which of connection_id and database it
/// needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Scope {
    Nothing,
    Connection,
    Database,
}

impl Tool {
    const ALL: [Tool; 18] = [
        Tool::ListConnections,
        Tool::ListDatabases,
        Tool::ListSchemas,
        Tool::ListTables,
        Tool::DescribeTable,
        Tool::Query,
        Tool::Explain,
        Tool::Execute,
        Tool::RunDdl,
        Tool::RunScript,
        Tool::RunScriptOnConnections,
        Tool::CreateConnection,
        Tool::UpdateConnection,
        Tool::DeleteConnection,
        Tool::SaveScript,
        Tool::GetHistory,
        Tool::GetTask,
        Tool::CancelTask,
    ];

    fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.name() == name)
    }

    fn name(self) -> &'static str {
        match self {
            Tool::ListConnections => "list_connections",
            Tool::ListDatabases => "list_databases",
            Tool::ListSchemas => "list_schemas",
            Tool::ListTables => "list_tables",
            Tool::DescribeTable => "describe_table",
            Tool::Query => "query",
            Tool::Explain => "explain",
            Tool::Execute => "execute",
            Tool::RunDdl => "run_ddl",
            Tool::RunScript => "run_script",
            Tool::RunScriptOnConnections => "run_script_on_connections",
            Tool::CreateConnection => "create_connection",
            Tool::UpdateConnection => "update_connection",
            Tool::DeleteConnection => "delete_connection",
            Tool::SaveScript => "save_script",
            Tool::GetHistory => "get_history",
            Tool::GetTask => "get_task",
            Tool::CancelTask => "cancel_task",
        }
    }

    /// The capability the tool needs.
    fn cap(self) -> Cap {
        match self {
            // About calls the client already made, each checked then.
            Tool::GetTask | Tool::CancelTask => Cap::Browse,
            Tool::ListConnections => Cap::ConnList,
            Tool::ListDatabases | Tool::ListSchemas | Tool::ListTables | Tool::DescribeTable => {
                Cap::Browse
            }
            Tool::Query | Tool::Explain => Cap::Read,
            Tool::Execute => Cap::Write,
            Tool::RunDdl => Cap::Ddl,
            Tool::RunScript | Tool::RunScriptOnConnections => Cap::Script,
            Tool::CreateConnection | Tool::UpdateConnection => Cap::ConnEdit,
            Tool::DeleteConnection => Cap::ConnDelete,
            Tool::SaveScript => Cap::SaveScript,
            // It shows what ran on the connections, SQL included.
            Tool::GetHistory => Cap::Read,
        }
    }

    fn scope(self) -> Scope {
        match self {
            Tool::ListConnections
            | Tool::CreateConnection
            | Tool::SaveScript
            | Tool::GetHistory
            | Tool::GetTask
            | Tool::CancelTask
            // its connections are checked one by one, in `many`
            | Tool::RunScriptOnConnections => Scope::Nothing,
            Tool::ListDatabases | Tool::UpdateConnection | Tool::DeleteConnection => {
                Scope::Connection
            }
            _ => Scope::Database,
        }
    }

    /// Whether the tool talks to PostgreSQL.
    fn uses_server(self) -> bool {
        !matches!(
            self,
            Tool::ListConnections
                | Tool::CreateConnection
                | Tool::UpdateConnection
                | Tool::DeleteConnection
                | Tool::SaveScript
                | Tool::GetHistory
                | Tool::GetTask
                | Tool::CancelTask
                // talks to several, in `many`
                | Tool::RunScriptOnConnections
        )
    }

    /// The capability this call needs: a read-only script needs only
    /// `read`.
    fn cap_for(self, args: &Value) -> Cap {
        match self {
            Tool::RunScript | Tool::RunScriptOnConnections
                if matches!(ScriptMode::of(args), Ok(ScriptMode::ReadOnly)) =>
            {
                Cap::Read
            }
            tool => tool.cap(),
        }
    }

    /// Whether the call may change data or settings, so running it twice
    /// would repeat the change.
    fn changes_data(self, args: &Value) -> bool {
        match self {
            Tool::RunScript | Tool::RunScriptOnConnections => {
                ScriptMode::of(args).map_or(true, ScriptMode::changes_data)
            }
            tool => !matches!(tool.cap(), Cap::Browse | Cap::Read | Cap::ConnList),
        }
    }
}

/// The connection level a capability needs on the connection it's about.
fn level_needed(cap: Cap) -> Level {
    match cap {
        Cap::Write | Cap::Ddl | Cap::Script => Level::Write,
        Cap::ConnList | Cap::SaveScript => Level::None,
        Cap::Browse | Cap::Read | Cap::ConnEdit | Cap::ConnDelete => Level::Read,
    }
}

/// The `tools/list` result: the tools whose capability isn't off.
pub(crate) fn definitions(config: &McpConfig) -> Value {
    let all = all_definitions();
    let tools: Vec<Value> = Tool::ALL
        .into_iter()
        .zip(all)
        .filter(|(tool, _)| {
            let on = |cap| policy::cap_policy(config, cap) != Policy::Off;
            // A read-only script needs only `read`.
            let script = matches!(tool, Tool::RunScript | Tool::RunScriptOnConnections);
            on(tool.cap()) || (script && on(Cap::Read))
        })
        .map(|(_, def)| def)
        .collect();
    Value::Array(tools)
}

/// Every tool's definition, in `Tool::ALL` order.
fn all_definitions() -> Vec<Value> {
    let connection_id =
        json!({ "type": "string", "description": "A connection's id, from list_connections." });
    let database = json!({ "type": "string", "description": "The database on that connection, from list_databases." });
    let read = json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false });
    let write = json!({ "readOnlyHint": false, "destructiveHint": true, "openWorldHint": false });
    let edit = json!({ "readOnlyHint": false, "destructiveHint": false, "openWorldHint": false });
    let task_id = json!({ "type": "string", "description": "The task_id a call answered with when it went on in the background." });
    let statement_timeout_ms = json!({ "type": "integer", "minimum": 1, "maximum": MAX_STATEMENT_MS, "default": DEFAULT_STATEMENT_MS, "description": "The statement_timeout it runs under, for a slow query on a large table. A call past about 40 s goes on in the background." });
    let on_database = |extra: Value, required: &[&str]| {
        let mut properties = Map::new();
        properties.insert("connection_id".into(), connection_id.clone());
        properties.insert("database".into(), database.clone());
        if let Value::Object(extra) = extra {
            properties.extend(extra);
        }
        let mut req = vec!["connection_id", "database"];
        req.extend(required);
        json!({ "type": "object", "properties": properties, "required": req })
    };
    let connection_fields = json!({
        "name": { "type": "string" },
        "uri": { "type": "string", "description": "A postgres:// or postgresql:// URI. A password in it is dropped: the user adds it in the app." },
        "host": { "type": "string", "description": "Instead of uri: the server's host." },
        "port": { "type": "integer", "description": "With host; 5432 when left out." },
        "default_database": { "type": "string", "description": "With host: the database to connect to first." },
        "username": { "type": "string" },
        "environment": { "type": "string", "enum": ["development", "testing", "staging", "production", "none"], "description": "What the connection is for. On production connections, the user is asked before every change. Only the user can take a connection out of production." },
    });
    vec![
        json!({
            "name": "list_connections",
            "description": "Lists the saved connections you may use: id, name, folder, environment (development, testing, staging, production, or null when not set), host and default database, and whether you may read or also write. On production connections the user is asked before every change. Never passwords or full connection strings.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": read,
        }),
        json!({
            "name": "list_databases",
            "description": "Lists the databases on a connection, with their sizes and owners.",
            "inputSchema": { "type": "object", "properties": { "connection_id": connection_id }, "required": ["connection_id"] },
            "annotations": read,
        }),
        json!({
            "name": "list_schemas",
            "description": "Lists the schemas of a database (system schemas left out).",
            "inputSchema": on_database(json!({}), &[]),
            "annotations": read,
        }),
        json!({
            "name": "list_tables",
            "description": "Lists the tables, views and materialized views of a database, or of one schema, with approximate row counts.",
            "inputSchema": on_database(json!({ "schema": { "type": "string", "description": "Only this schema." } }), &[]),
            "annotations": read,
        }),
        json!({
            "name": "describe_table",
            "description": "A table's columns with types, nullability and defaults, its primary key, foreign keys in both directions, constraints and indexes. No row values.",
            "inputSchema": on_database(json!({ "table": { "type": "string", "description": "schema.table, or just table (public first)." } }), &["table"]),
            "annotations": read,
        }),
        json!({
            "name": "query",
            "description": "Runs one SELECT (or WITH ... SELECT, VALUES, TABLE, SHOW) in a read-only transaction and returns its rows as JSON lines, values as text.",
            "inputSchema": on_database(json!({
                "sql": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_ROWS, "default": DEFAULT_ROWS },
                "timeout_ms": statement_timeout_ms.clone(),
            }), &["sql"]),
            "annotations": read,
        }),
        json!({
            "name": "explain",
            "description": "The plan of one read statement. With analyze, it runs (read-only, then rolled back) and reports actual rows and times.",
            "inputSchema": on_database(json!({
                "sql": { "type": "string" },
                "analyze": { "type": "boolean", "default": false },
                "timeout_ms": statement_timeout_ms.clone(),
            }), &["sql"]),
            "annotations": read,
        }),
        json!({
            "name": "execute",
            "description": "Runs one INSERT, UPDATE, DELETE or MERGE and commits it. It first runs once in a transaction that is rolled back, to count the rows it changes; the user may be asked to approve it with that count. RETURNING rows come back as JSON lines.",
            "inputSchema": on_database(json!({ "sql": { "type": "string" }, "timeout_ms": statement_timeout_ms }), &["sql"]),
            "annotations": write,
        }),
        json!({
            "name": "run_ddl",
            "description": "Runs one statement that changes the schema or its grants: CREATE, ALTER, DROP, TRUNCATE, COMMENT, GRANT, REVOKE, REINDEX, REFRESH MATERIALIZED VIEW, ANALYZE or VACUUM. It runs on its own, so CREATE INDEX CONCURRENTLY works.",
            "inputSchema": on_database(json!({ "sql": { "type": "string" } }), &["sql"]),
            "annotations": write,
        }),
        json!({
            "name": "run_script",
            "description": "Runs several SQL statements in order, each committing on its own unless the script opens a transaction, stopping at the first error. Reports what each did, with the first rows of each result. A transaction left open is rolled back. With read_only, it may hold only reads (SELECT, WITH, VALUES, TABLE, SHOW, EXPLAIN), runs in a read-only transaction and needs only read access. With dry_run, it runs in one transaction that is rolled back and reports what each statement would do (rows it would change, schema changes it would make): it still takes locks and fires triggers, may not hold BEGIN, COMMIT or ROLLBACK, and needs the same access as a real run.",
            "inputSchema": on_database(json!({
                "sql": { "type": "string" },
                "timeout_ms": { "type": "integer", "minimum": 1, "maximum": MAX_SCRIPT_MS, "default": DEFAULT_SCRIPT_MS },
                "read_only": { "type": "boolean", "default": false, "description": "Only reads; needs only read access." },
                "dry_run": { "type": "boolean", "default": false, "description": "Run it in a transaction that is rolled back, to see what it would do." },
            }), &["sql"]),
            "annotations": write,
        }),
        json!({
            "name": "run_script_on_connections",
            "description": "Runs the same script on several connections, one after the other, and returns each one's result - e.g. the same fix on every tenant's or region's database. Same as run_script (sql, timeout_ms per connection, read_only, dry_run), with targets instead of connection_id and database. When the user has to approve it, they are asked once for all of them. A failure on one doesn't stop the others unless stop_on_error is true.",
            "inputSchema": { "type": "object", "properties": {
                "targets": { "type": "array", "minItems": 1, "maxItems": many::MAX_TARGETS, "description": "Where to run it: a connection_id from list_connections and a database on it, for each.",
                    "items": { "type": "object", "properties": { "connection_id": connection_id.clone(), "database": database.clone() }, "required": ["connection_id", "database"] } },
                "sql": { "type": "string" },
                "timeout_ms": { "type": "integer", "minimum": 1, "maximum": MAX_SCRIPT_MS, "default": DEFAULT_SCRIPT_MS },
                "read_only": { "type": "boolean", "default": false, "description": "Only reads; needs only read access." },
                "dry_run": { "type": "boolean", "default": false, "description": "Run it in a transaction that is rolled back on each, to see what it would do." },
                "stop_on_error": { "type": "boolean", "default": false, "description": "Don't run on the targets after the first failure." },
            }, "required": ["targets", "sql"] },
            "annotations": write,
        }),
        json!({
            "name": "create_connection",
            "description": "Saves a new connection, from a uri or a host. It's saved without a password, which the user adds in the app; you get read access to it.",
            "inputSchema": { "type": "object", "properties": {
                "name": connection_fields["name"], "uri": connection_fields["uri"], "host": connection_fields["host"],
                "port": connection_fields["port"], "default_database": connection_fields["default_database"],
                "username": connection_fields["username"],
                "environment": connection_fields["environment"],
                "folder": { "type": "string", "description": "A folder of the user's sidebar, by name." },
            }, "required": ["name"] },
            "annotations": edit,
        }),
        json!({
            "name": "update_connection",
            "description": "Renames a saved connection, changes where it connects, or marks what it is for (its environment). Passwords can't be set here.",
            "inputSchema": { "type": "object", "properties": {
                "connection_id": connection_id, "name": connection_fields["name"], "uri": connection_fields["uri"],
                "host": connection_fields["host"], "port": connection_fields["port"],
                "default_database": connection_fields["default_database"], "username": connection_fields["username"],
                "environment": connection_fields["environment"],
            }, "required": ["connection_id"] },
            "annotations": edit,
        }),
        json!({
            "name": "delete_connection",
            "description": "Deletes a saved connection and its saved password.",
            "inputSchema": { "type": "object", "properties": { "connection_id": connection_id }, "required": ["connection_id"] },
            "annotations": write,
        }),
        json!({
            "name": "save_script",
            "description": "Saves SQL as a script in the user's Saved scripts, marked as yours.",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string" },
                "content": { "type": "string" },
                "database": { "type": "string", "description": "The database it is for, noted at the top." },
            }, "required": ["name", "content"] },
            "annotations": edit,
        }),
        json!({
            "name": "get_history",
            "description": "What MCP clients changed through Postgres Studio, newest first, as kept on this computer when the user keeps a history: every write, schema change, script, and connection edit that ran, with its SQL, time, connection and environment, who approved it, and what it changed or why it failed. Markdown is ready to paste into a ticket or pull request. Only connections you may read are shown.",
            "inputSchema": { "type": "object", "properties": {
                "connection_id": { "type": "string", "description": "Only this connection's entries." },
                "since": { "type": "string", "description": "Only entries from then on: a date (2026-11-16) or an RFC 3339 date-time." },
                "limit": { "type": "integer", "minimum": 1, "maximum": MAX_HISTORY, "default": DEFAULT_HISTORY },
                "format": { "type": "string", "enum": ["markdown", "json"], "default": "markdown" },
            } },
            "annotations": read,
        }),
        json!({
            "name": "get_task",
            "description": "Follow a call that went on in the background: a call that takes more than about 40 seconds (waiting for the user's approval, or a long script or query) answers with a task_id instead of its result. This waits up to wait_ms for it to end and returns its result, or else its status and what it reported so far (a script's finished statements and notices).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": task_id,
                    "wait_ms": { "type": "integer", "minimum": 0, "maximum": MAX_TASK_WAIT_MS, "default": DEFAULT_TASK_WAIT_MS, "description": "How long to wait for the task to end before answering with its status." },
                    "from_line": { "type": "integer", "minimum": 0, "default": 0, "description": "Show reported lines from this index on (the previous status says which to pass)." },
                },
                "required": ["task_id"],
            },
            "annotations": read,
        }),
        json!({
            "name": "cancel_task",
            "description": "Stop a call that went on in the background: withdraws a request still waiting for the user's approval, or stops a running script or statement on the server. What was already committed stays; an open transaction is rolled back.",
            "inputSchema": { "type": "object", "properties": { "task_id": task_id }, "required": ["task_id"] },
            "annotations": write,
        }),
    ]
}

#[derive(Debug, Clone)]
pub(crate) struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

/// What a tool call is about.
#[derive(Default)]
struct Target {
    connection_id: Option<String>,
    profile: Option<ConnectionProfile>,
    database: Option<String>,
    /// What it does there, e.g. "UPDATE public.customers".
    detail: Option<String>,
    /// A call on several connections: their names, ids and environments,
    /// for the history.
    names: Option<String>,
    ids: Vec<String>,
    environments: Option<String>,
}

impl Target {
    /// `shop · UPDATE public.customers`, `shop`, or the connection's name.
    fn text(&self) -> String {
        match (&self.database, &self.detail) {
            (Some(db), Some(detail)) => format!("{db} · {detail}"),
            (Some(db), None) => db.clone(),
            (None, Some(detail)) => detail.clone(),
            _ => self
                .profile
                .as_ref()
                .map(|p| p.name.clone())
                .unwrap_or_default(),
        }
    }

    fn db(&self) -> &str {
        self.database.as_deref().unwrap_or_default()
    }
}

/// The approval card and the dry run.
struct Plan {
    title: String,
    code: String,
    dry_run: Option<String>,
    /// The checked SQL the call runs.
    sql: Option<String>,
}

/// A successful call: text for the client, meta for the activity line.
struct Done {
    text: String,
    meta: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityEvent<'a> {
    at: u64,
    client_name: &'a str,
    tool: &'a str,
    target: String,
    connection_id: Option<&'a str>,
    meta: String,
    result: &'a str,
    label: String,
}

struct Call<'a> {
    inner: &'a Arc<Inner>,
    client: &'a ClientSession,
    tool: Tool,
    target: Target,
    started: Instant,
    /// Followed by get_task when the call outlasts `inline_wait`.
    task: Arc<Task>,
    /// A read that lost its connection and ran again.
    retried: bool,
    /// What runs, as the approval card shows it, for the history.
    code: Option<String>,
}

impl Call<'_> {
    /// Reports the call to the windows and builds the output.
    fn finish(&self, result: &str, label: String, meta: String, text: String) -> ToolOutput {
        self.record(result, &label, &meta, &text);
        self.inner.emit(
            ACTIVITY_EVENT,
            &ActivityEvent {
                at: now_ms(),
                client_name: &self.client.name,
                tool: self.tool.name(),
                target: self.target.text(),
                connection_id: self.target.connection_id.as_deref(),
                meta: truncate(meta, MAX_META),
                result,
                label: truncate(label, MAX_META),
            },
        );
        ToolOutput {
            text: truncate(text, MAX_OUTPUT),
            is_error: result != "ok",
        }
    }

    /// Keeps a call that ran and could change something - and every
    /// script, read-only and dry runs too - in the history, when the user
    /// keeps one.
    fn record(&self, result: &str, label: &str, meta: &str, text: &str) {
        let script = matches!(self.tool, Tool::RunScript | Tool::RunScriptOnConnections);
        if self.task.phase() != Phase::Running || !(self.task.changes_data || script) {
            return;
        }
        if !self.inner.config().history {
            return;
        }
        let profile = self.target.profile.as_ref();
        let failed = result != "ok";
        let entry = HistoryEntry {
            at: now_ms(),
            client: self.client.name.clone(),
            tool: self.tool.name().to_string(),
            connection_id: self.target.connection_id.clone(),
            connection_ids: self.target.ids.clone(),
            connection_name: profile
                .map(|p| p.name.clone())
                .or_else(|| self.target.names.clone()),
            environment: profile
                .and_then(|p| p.environment)
                .map(|e| e.id().to_string())
                .or_else(|| self.target.environments.clone()),
            target: self.target.text(),
            code: self.code.clone().unwrap_or_default(),
            outcome: if failed { "error" } else { "ok" }.to_string(),
            summary: meta.to_string(),
            error: failed.then(|| logging::scrub_credentials(text)),
            approval: label.split(" · ").next().unwrap_or(label).to_string(),
            duration_ms: self.started.elapsed().as_millis() as u64,
        };
        if let Err(e) = self.inner.history.append(entry) {
            log::warn!("MCP server: couldn't add to the history: {e}");
        }
    }

    fn log(&self, outcome: &str) {
        let connection = match &self.target.profile {
            Some(p) => format!(" [\"{}\" ({})]", p.name, p.id),
            None => String::new(),
        };
        let on = match &self.target.database {
            Some(db) => format!(" on {db}"),
            None => String::new(),
        };
        log::info!(
            "MCP {}: {}{on}{connection}: {outcome} ({} ms)",
            self.client.name,
            self.tool.name(),
            self.started.elapsed().as_millis()
        );
    }

    fn refuse(&self, label: &str, text: &str) -> ToolOutput {
        self.log(label);
        self.finish("warn", label.to_string(), String::new(), text.to_string())
    }

    /// A lost connection, told as one: what to check, whether the call
    /// was retried, and that a change may or may not have been applied.
    /// The connection is closed, so the next call connects afresh (and
    /// opens a new SSH tunnel).
    fn network_error(&self, error: AppError) -> AppError {
        let Some(profile) = &self.target.profile else {
            return error;
        };
        if !lost_connection(&error) {
            return error;
        }
        let inner = self.inner.clone();
        let id = profile.id.clone();
        tokio::spawn(async move { inner.pool.close(&id, "the connection was lost").await });
        let original = logging::scrub_credentials(&error.to_string());
        let mut text = format!(
            "Lost the connection to \"{}\" ({original}). Check the VPN or the network{} and try again.",
            profile.name,
            if profile.ssh_tunnel.is_some() {
                ", and the SSH server"
            } else {
                ""
            },
        );
        if self.retried {
            text.push_str(" The call was retried once after reconnecting, and failed again.");
        } else if self.task.changes_data && self.task.phase() == Phase::Running {
            text.push_str(
                " It changes data, so it wasn't retried: check whether it was applied before \
                 running it again.",
            );
        }
        AppError::Network(text)
    }

    fn fail(&self, error: AppError) -> ToolOutput {
        let error = self.network_error(error);
        self.log(&format!(
            "failed: {}",
            logging::describe(&error, Detail::NoUserData)
        ));
        let message = logging::scrub_credentials(&error.to_string());
        self.finish("err", format!("Failed: {message}"), String::new(), message)
    }
}

/// Runs a `tools/call`. `None` when there's no tool by that name.
pub(crate) async fn call(
    inner: &Arc<Inner>,
    client: &ClientSession,
    name: &str,
    args: Value,
) -> Option<ToolOutput> {
    let tool = Tool::from_name(name)?;
    let args = match args {
        Value::Object(map) => Value::Object(map),
        _ => json!({}),
    };
    let task_id = str_arg(&args, "task_id").unwrap_or_default();
    match tool {
        Tool::GetTask => {
            let wait = whole_arg(&args, "wait_ms")
                .unwrap_or(DEFAULT_TASK_WAIT_MS)
                .clamp(0, MAX_TASK_WAIT_MS);
            let from_line = whole_arg(&args, "from_line").unwrap_or(0).max(0) as usize;
            let wait = Duration::from_millis(wait as u64);
            return Some(tasks::get(inner, &task_id, wait, from_line).await);
        }
        Tool::CancelTask => return Some(tasks::cancel(inner, &task_id)),
        _ => {}
    }
    let task = Task::new(&client.id, tool.name(), tool.changes_data(&args));
    let (owned_inner, owned_client, followed) = (inner.clone(), client.clone(), task.clone());
    let work = async move {
        let mut call = Call {
            inner: &owned_inner,
            client: &owned_client,
            tool,
            target: Target::default(),
            started: Instant::now(),
            task: followed,
            retried: false,
            code: None,
        };
        run_call(&mut call, &args).await
    };
    Some(tasks::run(inner, task, work).await)
}

/// An integer argument that may be 0, also when sent as a string.
fn whole_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
    })
}

async fn run_call(call: &mut Call<'_>, args: &Value) -> ToolOutput {
    let tool = call.tool;
    if tool == Tool::RunScriptOnConnections {
        return many::run(call, args).await;
    }
    let scope = tool.scope();
    if scope >= Scope::Connection {
        match str_arg(args, "connection_id") {
            Some(id) => call.target.connection_id = Some(id),
            None => {
                return call.fail(invalid(
                    "connection_id is required: take it from list_connections.",
                ))
            }
        }
    }
    if scope >= Scope::Database {
        match str_arg(args, "database") {
            Some(db) => call.target.database = Some(db),
            None => return call.fail(invalid("database is required: see list_databases.")),
        }
    }

    let cap = tool.cap_for(args);
    let config = call.inner.config();
    let decision = policy::decide(
        &config,
        cap,
        call.target.connection_id.as_deref(),
        level_needed(cap),
    );
    match decision {
        Decision::Off => return call.refuse("Refused: turned off", policy::REFUSED_OFF),
        Decision::NoAccess => return call.refuse("Refused: no access", policy::REFUSED_NO_ACCESS),
        Decision::Ask | Decision::Allow | Decision::AllowAlways => {}
    }

    if let Some(id) = &call.target.connection_id {
        match call.inner.state().connection_store.get(id) {
            Ok(profile) => call.target.profile = Some(profile),
            Err(_) => {
                return call.fail(AppError::NotFound(
                    "no saved connection has this id; call list_connections".to_string(),
                ))
            }
        }
    }

    // On production, every change is asked about.
    let production = call
        .target
        .profile
        .as_ref()
        .is_some_and(|p| p.environment == Some(Environment::Production));
    // A dry run changes nothing, but takes locks and fires triggers.
    let guarded =
        production && config.confirm_production && (call.task.changes_data || cap == Cap::Script);
    let decision = match decision {
        Decision::Allow | Decision::AllowAlways if guarded => Decision::Ask,
        other => other,
    };

    let session = if tool.uses_server() {
        let profile = call.target.profile.as_ref().expect("checked above");
        match call
            .inner
            .pool
            .session(call.inner.host.as_ref(), profile)
            .await
        {
            Ok(session) => Some(session),
            Err(e) => return call.fail(e),
        }
    } else {
        None
    };

    let plan = match plan(call, args, session.as_deref()).await {
        Ok(plan) => plan,
        Err(e) => return call.fail(e),
    };
    call.code = Some(plan.code.clone());

    let label = match decision {
        Decision::Allow => "Allowed",
        Decision::AllowAlways => "Allowed (always)",
        _ => {
            call.task.set_phase(Phase::Approval);
            let request = Request {
                tool: tool.name(),
                capability: cap,
                connection_id: call.target.connection_id.clone(),
                connection_name: call.target.profile.as_ref().map(|p| p.name.clone()),
                database: call.target.database.clone(),
                title: plan.title.clone(),
                code: truncate(plan.code.clone(), MAX_CODE),
                dry_run: plan.dry_run.clone(),
                connection_ids: Vec::new(),
                production: guarded,
            };
            match policy::ask(call.inner, call.client, &request).await {
                Answer::Once => "Approved by you",
                Answer::Always => "Approved by you (always)",
                Answer::Deny => return call.refuse("Denied by you", policy::DENIED),
                Answer::Timeout => return call.refuse("Not answered", policy::NOT_ANSWERED),
                Answer::Closed => return call.refuse("Closed", policy::CLOSED),
            }
        }
    };

    call.task.set_phase(Phase::Running);
    let timeout = match tool {
        Tool::RunScript => script_timeout(args) + OP_MARGIN,
        _ => statement_timeout(args) + OP_MARGIN,
    };
    let mut result = tokio::time::timeout(timeout, execute(call, args, session.as_deref(), &plan))
        .await
        .unwrap_or_else(|_| Err(invalid("The operation timed out.")));
    // A read that lost its connection runs once more on a fresh one.
    let lost = matches!(&result, Err(e) if lost_connection(e));
    if lost && tool.uses_server() && !tool.changes_data(args) {
        let profile = call.target.profile.clone().expect("checked above");
        call.inner
            .pool
            .close(&profile.id, "the connection was lost")
            .await;
        call.retried = true;
        log::info!("MCP: {} lost its connection; retrying once", tool.name());
        match call
            .inner
            .pool
            .session(call.inner.host.as_ref(), &profile)
            .await
        {
            Ok(fresh) => {
                result = tokio::time::timeout(timeout, execute(call, args, Some(&fresh), &plan))
                    .await
                    .unwrap_or_else(|_| Err(invalid("The operation timed out.")));
            }
            Err(e) => result = Err(e),
        }
    }
    match result {
        Ok(done) => {
            call.log(label);
            call.finish("ok", label.to_string(), done.meta, done.text)
        }
        Err(e) => call.fail(e),
    }
}

/// Whether an error says the connection to the server was lost or
/// couldn't be made: a reset, a refused or timed-out connect, a dead SSH
/// tunnel, the server shutting down. Statement errors that reach here as
/// text are read by how the driver words them, never by their middle (a
/// script's output may hold any text).
pub(crate) fn lost_connection(error: &AppError) -> bool {
    match error {
        AppError::Io(_) | AppError::Ssh(_) | AppError::Network(_) => true,
        AppError::Database(db) => match db.code.as_deref() {
            Some(code) => connection_sqlstate(code),
            None => says_network(&db.message),
        },
        AppError::InvalidInput(text) => says_network(text),
        _ => false,
    }
}

/// SQLSTATE class 08 (connection exception), and the server going away.
fn connection_sqlstate(code: &str) -> bool {
    code.starts_with("08") || matches!(code, "57P01" | "57P02" | "57P03")
}

fn says_network(text: &str) -> bool {
    const SIGNS: &[&str] = &[
        "error communicating with the server",
        "error connecting to server",
        "connection closed",
        "error performing tls handshake",
        "terminating connection due to administrator command",
        "the database system is shutting down",
        "the database system is starting up",
        "ssh tunnel error",
    ];
    let text = text.trim_start().to_ascii_lowercase();
    SIGNS.iter().any(|sign| text.starts_with(sign))
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

/// The statement timeout a read, write or dry run runs under.
fn statement_timeout(args: &Value) -> Duration {
    Duration::from_millis(
        int_arg(args, "timeout_ms", DEFAULT_STATEMENT_MS, MAX_STATEMENT_MS) as u64,
    )
}

/// `statement_timeout(args)` as PostgreSQL takes it: `45000ms`.
fn statement_timeout_setting(args: &Value) -> String {
    format!("{}ms", statement_timeout(args).as_millis())
}

/// A boolean argument, also when sent as a string ("true").
fn bool_arg(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.trim().eq_ignore_ascii_case("true"),
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        _ => false,
    }
}

fn script_timeout(args: &Value) -> Duration {
    Duration::from_millis(int_arg(args, "timeout_ms", DEFAULT_SCRIPT_MS, MAX_SCRIPT_MS) as u64)
}

fn sql_arg(args: &Value) -> AppResult<String> {
    args.get("sql")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| invalid("sql is required."))
}

/// The one statement of `sql`, if its command is one of `allowed`.
fn one_statement(sql: &str, allowed: &[&str], what: &str) -> AppResult<(String, String)> {
    let statements = split::split(sql);
    let [stmt] = statements.as_slice() else {
        return Err(invalid(format!(
            "Send exactly one statement here; run_script runs several. This holds {}.",
            statements.len()
        )));
    };
    let command = run::command_of(&stmt.text);
    let first = command.split(' ').next().unwrap_or_default();
    if !allowed.contains(&first) {
        return Err(invalid(format!("Only {what} run here, not {command}.")));
    }
    Ok((stmt.text.clone(), command))
}

/// What a write is about: `UPDATE public.customers`.
fn write_target(sql: &str, command: &str) -> String {
    let words: Vec<&str> = sql.split_whitespace().collect();
    let after = |keyword: &str| {
        words
            .iter()
            .position(|w| w.eq_ignore_ascii_case(keyword))
            .and_then(|i| {
                words[i + 1..]
                    .iter()
                    .find(|w| !w.eq_ignore_ascii_case("ONLY"))
            })
            .map(|w| {
                w.split('(')
                    .next()
                    .unwrap_or_default()
                    .trim_end_matches([',', ';'])
                    .to_string()
            })
    };
    let table = match command {
        "UPDATE" => after("UPDATE"),
        "DELETE" => after("FROM"),
        "INSERT" | "MERGE" => after("INTO"),
        _ => None,
    };
    match table {
        Some(t) if !t.is_empty() => format!("{command} {t}"),
        _ => command.to_string(),
    }
}

/// The checks, the approval card's text and the dry run of a call.
async fn plan(call: &mut Call<'_>, args: &Value, session: Option<&PgSession>) -> AppResult<Plan> {
    let empty = Plan {
        title: String::new(),
        code: String::new(),
        dry_run: None,
        sql: None,
    };
    match call.tool {
        Tool::Query | Tool::Explain => {
            let sql = sql_arg(args)?;
            // Read-only still lets these act on the server; the Assistant's
            // check says so in its own words, so this one comes first.
            if let Some(f) = denied_function(&sql) {
                return Err(invalid(format!(
                    "{f} acts on the server: use run_script, if the user allows it."
                )));
            }
            let sql = agent_sql(&sql).map_err(invalid)?;
            call.target.detail = Some(run::command_of(&sql));
            Ok(Plan {
                title: format!("{} in {}", run::command_of(&sql), call.target.db()),
                code: sql.clone(),
                sql: Some(sql),
                ..empty
            })
        }
        Tool::Execute => {
            let (sql, command) = one_statement(
                &sql_arg(args)?,
                &WRITE_COMMANDS,
                "INSERT, UPDATE, DELETE and MERGE",
            )?;
            if let Some(f) = denied_function(&sql) {
                return Err(invalid(format!(
                    "{f} acts on the server: use run_script, if the user allows it."
                )));
            }
            let detail = write_target(&sql, &command);
            call.target.detail = Some(detail.clone());
            let client = session
                .expect("uses the server")
                .client(call.target.db())
                .await?;
            let stop = StopOnDrop::new(&client);
            let dry = write(&client, &sql, false, &statement_timeout_setting(args)).await;
            stop.disarm();
            let dry = dry?;
            Ok(Plan {
                title: detail.clone(),
                code: sql.clone(),
                dry_run: Some(format!("{} · rolled back", dry.tag(&command))),
                sql: Some(sql),
            })
        }
        Tool::RunDdl => {
            let (sql, command) = one_statement(&sql_arg(args)?, &DDL_COMMANDS, "schema changes")?;
            call.target.detail = Some(command.clone());
            Ok(Plan {
                title: command,
                code: sql.clone(),
                sql: Some(sql),
                ..empty
            })
        }
        Tool::RunScript => {
            let sql = sql_arg(args)?;
            let mode = ScriptMode::of(args)?;
            let n = check_script(&sql, mode)?;
            let statements = plural(n as u64, "statement", "statements");
            call.target.detail = Some(statements.clone());
            let title = match mode {
                ScriptMode::Normal => format!("A script of {statements}"),
                ScriptMode::ReadOnly => format!("A read-only script of {statements}"),
                ScriptMode::DryRun => format!("A dry run (rolled back) of {statements}"),
            };
            Ok(Plan {
                title,
                code: sql.clone(),
                sql: Some(sql),
                ..empty
            })
        }
        Tool::CreateConnection => {
            let new = connection_args(args, true)?;
            let name = new.name.clone().unwrap_or_default();
            call.target.detail = Some(name.clone());
            Ok(Plan {
                title: format!("Save a new connection, \"{name}\""),
                code: new.describe(),
                ..empty
            })
        }
        Tool::UpdateConnection => {
            let change = connection_args(args, false)?;
            let profile = call.target.profile.as_ref().expect("checked before");
            check_environment_change(profile.environment, change.environment)?;
            Ok(Plan {
                title: format!("Change the connection \"{}\"", profile.name),
                code: change.describe(),
                ..empty
            })
        }
        Tool::DeleteConnection => {
            let profile = call.target.profile.as_ref().expect("checked before");
            Ok(Plan {
                title: format!("Delete the connection \"{}\"", profile.name),
                code: format!("{} at {}", profile.name, logging::host_summary(profile)),
                ..empty
            })
        }
        Tool::SaveScript => {
            let name = name_arg(args).ok_or_else(|| invalid("name is required."))?;
            let content = args
                .get("content")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| invalid("content is required."))?;
            call.target.detail = Some(name.clone());
            Ok(Plan {
                title: format!("Save the script \"{name}\""),
                code: content.to_string(),
                ..empty
            })
        }
        _ => Ok(empty),
    }
}

async fn execute(
    call: &Call<'_>,
    args: &Value,
    session: Option<&PgSession>,
    plan: &Plan,
) -> AppResult<Done> {
    let db = call.target.db();
    match call.tool {
        Tool::ListConnections => Ok(list_connections(call.inner)),
        Tool::ListDatabases => {
            let session = session.expect("uses the server");
            let client = session.client(&session.target.default_db).await?;
            let databases = catalog::list_databases(&client).await?;
            let lines: Vec<String> = databases
                .iter()
                .map(|d| {
                    let mut line = d.name.clone();
                    let mut notes = Vec::new();
                    if let Some(bytes) = d.size_bytes {
                        notes.push(format!("{} bytes", thousands(bytes.max(0) as u64)));
                    }
                    if let Some(owner) = &d.owner {
                        notes.push(format!("owner {owner}"));
                    }
                    if !notes.is_empty() {
                        line.push_str(&format!(" ({})", notes.join(", ")));
                    }
                    line
                })
                .collect();
            let count = plural(lines.len() as u64, "database", "databases");
            Ok(Done {
                text: format!("{count}:\n{}", lines.join("\n")),
                meta: count,
            })
        }
        Tool::ListSchemas => {
            let client = session.expect("uses the server").client(db).await?;
            let schemas = catalog::list_schemas(&client).await?;
            let lines: Vec<String> = schemas
                .iter()
                .filter(|s| !s.system)
                .map(|s| match &s.owner {
                    Some(owner) => format!("{} (owner {owner})", s.name),
                    None => s.name.clone(),
                })
                .collect();
            let count = plural(lines.len() as u64, "schema", "schemas");
            Ok(Done {
                text: format!("{count} in {db}:\n{}", lines.join("\n")),
                meta: count,
            })
        }
        Tool::ListTables => {
            let client = session.expect("uses the server").client(db).await?;
            let (text, count) = tables_listing(&client, str_arg(args, "schema").as_deref())
                .await
                .map_err(invalid)?;
            Ok(Done { text, meta: count })
        }
        Tool::DescribeTable => {
            let client = session.expect("uses the server").client(db).await?;
            let table = str_arg(args, "table").ok_or_else(|| invalid("table is required."))?;
            let (schema, name) = resolve(&client, &table).await.map_err(invalid)?;
            let info = catalog::describe_table(&client, &schema, &name).await?;
            Ok(Done {
                text: describe(&info, true),
                meta: format!(
                    "{schema}.{name} · {}",
                    plural(info.columns.len() as u64, "column", "columns")
                ),
            })
        }
        Tool::Query => {
            let client = session.expect("uses the server").client(db).await?;
            let sql = plan.sql.as_deref().unwrap_or_default();
            let limit = int_arg(args, "limit", DEFAULT_ROWS, MAX_ROWS) as usize;
            let stop = StopOnDrop::new(&client);
            let rows = read_only_with(&client, sql, limit, &statement_timeout_setting(args)).await;
            stop.disarm();
            let rows = rows.map_err(invalid)?;
            let shown = rows.rows.len() as u64;
            let mut text = format!(
                "{} (values as text, one JSON object per line):\n{}",
                plural(shown, "row", "rows"),
                json_lines(&rows.columns, &rows.rows)
            );
            if rows.total > shown {
                text.push_str(&format!(
                    "\n... and more: only the first {} are shown. Add a LIMIT, a WHERE, or raise limit (up to {MAX_ROWS}).",
                    thousands(shown)
                ));
            }
            Ok(Done {
                text,
                meta: plural(shown, "row", "rows"),
            })
        }
        Tool::Explain => {
            let client = session.expect("uses the server").client(db).await?;
            let sql = plan.sql.as_deref().unwrap_or_default();
            let analyze = bool_arg(args, "analyze");
            let explain = if analyze {
                format!("EXPLAIN (ANALYZE, BUFFERS) {sql}")
            } else {
                format!("EXPLAIN {sql}")
            };
            let stop = StopOnDrop::new(&client);
            let rows = read_only_with(
                &client,
                &explain,
                usize::MAX,
                &statement_timeout_setting(args),
            )
            .await;
            stop.disarm();
            let rows = rows.map_err(invalid)?;
            let plan_lines: Vec<String> = rows
                .rows
                .into_iter()
                .filter_map(|r| r.into_iter().next().flatten())
                .collect();
            let meta = plan_lines
                .first()
                .map(|l| l.split("  (").next().unwrap_or(l).trim().to_string())
                .unwrap_or_default();
            Ok(Done {
                text: format!("Plan on {db}:\n{}", plan_lines.join("\n")),
                meta,
            })
        }
        Tool::Execute => {
            let client = session.expect("uses the server").client(db).await?;
            let sql = plan.sql.as_deref().unwrap_or_default();
            let command = run::command_of(sql);
            let stop = StopOnDrop::new(&client);
            let done = write(&client, sql, true, &statement_timeout_setting(args)).await;
            stop.disarm();
            let done = done?;
            let tag = done.tag(&command);
            let mut text = format!("{tag}: committed.");
            if let Some(dry) = &plan.dry_run {
                text.push_str(&format!(" The dry run said: {dry}."));
            }
            if !done.columns.is_empty() {
                text.push_str(&format!(
                    "\nReturned {} (one JSON object per line):\n{}",
                    plural(done.total, "row", "rows"),
                    json_lines(&done.columns, &done.rows)
                ));
            }
            Ok(Done { text, meta: tag })
        }
        Tool::RunDdl => {
            let client = session.expect("uses the server").client(db).await?;
            let sql = plan.sql.as_deref().unwrap_or_default();
            let command = run::command_of(sql);
            let canceller = client.canceller();
            // Stops the statement on the server too when the call times out.
            let guard = CancelOnDrop(Some(canceller));
            client
                .client
                .simple_query(sql)
                .await
                .map_err(|e| invalid(DbError::from_pg(&e).to_string()))?;
            guard.disarm();
            Ok(Done {
                text: format!("{command}: done."),
                meta: command,
            })
        }
        Tool::RunScript => {
            let session = session.expect("uses the server");
            let sql = plan.sql.as_deref().unwrap_or_default();
            run_script(
                session,
                db,
                sql,
                script_timeout(args),
                ScriptMode::of(args)?,
                &call.task,
            )
            .await
        }
        Tool::CreateConnection => create_connection(call, args),
        Tool::UpdateConnection => update_connection(call, args).await,
        Tool::DeleteConnection => delete_connection(call).await,
        Tool::SaveScript => save_script(call, args),
        Tool::GetHistory => get_history(call, args),
        Tool::GetTask | Tool::CancelTask => unreachable!("answered before a call starts"),
        Tool::RunScriptOnConnections => unreachable!("run by many::run"),
    }
}

/// Rows as JSON objects, one per line, values as text.
fn json_lines(columns: &[String], rows: &[Vec<Option<String>>]) -> String {
    rows.iter()
        .map(|r| {
            let object: Map<String, Value> = columns
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
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a write did: the rows it changed, and what RETURNING sent back.
struct Written {
    changed: u64,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    total: u64,
}

impl Written {
    /// `UPDATE 12`, as psql would say it.
    fn tag(&self, command: &str) -> String {
        format!("{command} {}", thousands(self.changed))
    }
}

/// Runs one statement that changes rows in a transaction of its own, with
/// a statement timeout: committed when `commit`, else rolled back (the dry
/// run). A failure rolls back too.
async fn write(client: &PgClient, sql: &str, commit: bool, timeout: &str) -> AppResult<Written> {
    let end = if commit { "COMMIT" } else { "ROLLBACK" };
    let batch = format!(
        "BEGIN;\nSET LOCAL statement_timeout = '{timeout}';\nSET LOCAL lock_timeout = '5s';\n{sql};\n{end}"
    );
    let result = async {
        let stream = client.client.simple_query_raw(&batch).await?;
        pin_mut!(stream);
        let mut out = Written {
            changed: 0,
            columns: Vec::new(),
            rows: Vec::new(),
            total: 0,
        };
        let mut completed = 0;
        while let Some(message) = stream.try_next().await? {
            match message {
                SimpleQueryMessage::RowDescription(cols) => {
                    out.columns = cols.iter().map(|c| c.name().to_string()).collect();
                }
                SimpleQueryMessage::Row(row) => {
                    out.total += 1;
                    if out.rows.len() < SHOWN_ROWS {
                        out.rows.push(
                            (0..row.len())
                                .map(|i| row.get(i).map(str::to_string))
                                .collect(),
                        );
                    }
                }
                SimpleQueryMessage::CommandComplete(n) => {
                    // BEGIN, SET, SET, the statement, then COMMIT or ROLLBACK.
                    if completed == 3 {
                        out.changed = n;
                    }
                    completed += 1;
                }
                _ => {}
            }
        }
        Ok::<_, tokio_postgres::Error>(out)
    }
    .await;
    match result {
        Ok(written) => Ok(written),
        Err(e) => {
            let _ = client.client.simple_query("ROLLBACK").await;
            Err(invalid(DbError::from_pg(&e).to_string()))
        }
    }
}

/// Stops what a pooled client runs when the call is dropped mid-way (it
/// timed out, or the client cancelled its task): cancels the statement on
/// the server, then rolls back the transaction it may have left open, so
/// the client is fit for the next call.
struct StopOnDrop(Option<Arc<PgClient>>);

impl StopOnDrop {
    fn new(client: &Arc<PgClient>) -> Self {
        Self(Some(client.clone()))
    }

    fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        if let Some(client) = self.0.take() {
            let canceller = client.canceller();
            tokio::spawn(async move {
                canceller.cancel().await;
                let _ = client.client.simple_query("ROLLBACK").await;
            });
        }
    }
}

/// Cancels the statement on the server when dropped before `disarm`: a
/// call that times out is dropped mid-statement.
struct CancelOnDrop(Option<crate::pg::connect::Canceller>);

impl CancelOnDrop {
    fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(canceller) = self.0.take() {
            tokio::spawn(async move { canceller.cancel().await });
        }
    }
}

/// The statements of a script, checked for its mode: how many.
fn check_script(sql: &str, mode: ScriptMode) -> AppResult<usize> {
    let statements = split::split(sql);
    if statements.is_empty() {
        return Err(invalid("The script holds no statement."));
    }
    if mode == ScriptMode::Normal {
        return Ok(statements.len());
    }
    // These act outside the transaction, so neither mode can hold them.
    if let Some(f) = denied_function(sql) {
        return Err(invalid(format!(
            "{f} acts on the server, outside any transaction: run it without read_only or dry_run, if the user allows it."
        )));
    }
    for (i, stmt) in statements.iter().enumerate() {
        let command = run::command_of(&stmt.text);
        let first = command.split(' ').next().unwrap_or_default();
        let n = i + 1;
        match mode {
            ScriptMode::ReadOnly if !READ_COMMANDS.contains(&first) => {
                return Err(invalid(format!(
                    "Statement {n} is {command}: a read_only script holds only SELECT, WITH, VALUES, TABLE, SHOW and EXPLAIN."
                )));
            }
            ScriptMode::DryRun if run::is_transaction_control(first) => {
                return Err(invalid(format!(
                    "Statement {n} is {command}: a dry run is one transaction that is rolled back, so it can't hold its own BEGIN, COMMIT or ROLLBACK."
                )));
            }
            ScriptMode::DryRun
                if first == "COPY" && stmt.text.to_ascii_lowercase().contains("program") =>
            {
                return Err(invalid(format!(
                    "Statement {n} runs a program on the server, which a rollback can't undo."
                )));
            }
            _ => {}
        }
    }
    Ok(statements.len())
}

/// One finished statement of a script: its summary line, then the rows
/// it returned.
fn statement_text(r: &run::StatementResult) -> (String, Option<String>) {
    let n = r.index + 1;
    match &r.error {
        Some(e) => (format!("{n}. {} failed: {e}", r.command), None),
        None if r.returns_rows => {
            let names: Vec<String> = r.columns.iter().map(|c| c.name.clone()).collect();
            (
                format!(
                    "{n}. {}: {}{}",
                    r.command,
                    plural(r.row_count, "row", "rows"),
                    if r.truncated {
                        format!(", the first {} shown", r.rows.len())
                    } else {
                        String::new()
                    }
                ),
                Some(json_lines(&names, &r.rows)),
            )
        }
        None => (
            format!("{n}. {} {}", r.command, thousands(r.row_count)),
            None,
        ),
    }
}

/// Runs a script on a connection of its own, which closes afterwards: a
/// transaction the script leaves open rolls back with it. Each statement
/// is reported to the task as it ends, so a status shows how far it got,
/// and a script stopped by its timeout still says what it had done.
async fn run_script(
    session: &PgSession,
    database: &str,
    sql: &str,
    timeout: Duration,
    mode: ScriptMode,
    task: &Arc<Task>,
) -> AppResult<Done> {
    let client = session.target.open(database).await?;
    let options = run::RunOptions {
        row_limit: SHOWN_ROWS,
        pooler_mode: session.target.settings.pooler_mode,
        wrap_read_only: false,
    };
    // The modes run in one transaction of their own, rolled back at the
    // end (the connection closing afterwards would roll it back anyway).
    let begin = match mode {
        ScriptMode::Normal => None,
        ScriptMode::ReadOnly => Some("BEGIN READ ONLY"),
        ScriptMode::DryRun => Some("BEGIN; SET LOCAL lock_timeout = '5s'"),
    };
    if let Some(begin) = begin {
        client
            .client
            .batch_execute(begin)
            .await
            .map_err(|e| invalid(DbError::from_pg(&e).to_string()))?;
    }
    // Stops the statement on the server when the call is dropped: past the
    // timeout below, or by cancel_task.
    let guard = CancelOnDrop(Some(client.canceller()));
    let finished = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let (sink, followed) = (finished.clone(), task.clone());
    let reporting = run::run_sql_reporting(&client, sql, options, None, move |r| {
        let (line, rows) = statement_text(r);
        followed.print(line.clone());
        let mut done = sink.lock().unwrap();
        done.push(line);
        if let Some(rows) = rows {
            done.push(rows);
        }
    });
    let Ok(ran) = tokio::time::timeout(timeout, reporting).await else {
        drop(guard);
        let done = finished.lock().unwrap().clone();
        let mut text = format!(
            "The script didn't finish within {} s and was stopped: the statement it was running \
             was cancelled, and a transaction the script had open was rolled back.",
            timeout.as_secs()
        );
        if done.is_empty() {
            text.push_str(" No statement had finished.");
        } else if mode != ScriptMode::Normal {
            text.push_str(&format!(
                " It ran in one transaction, rolled back, so nothing was kept. These had finished:\n{}",
                done.join("\n")
            ));
        } else {
            text.push_str(&format!(
                " These had finished, each committed on its own unless inside that transaction - \
                 check what was applied before running the rest:\n{}",
                done.join("\n")
            ));
        }
        return Err(invalid(text));
    };
    guard.disarm();
    if begin.is_some() {
        let _ = client.client.batch_execute("ROLLBACK").await;
    }
    let mut text = match mode {
        ScriptMode::Normal | ScriptMode::ReadOnly => String::new(),
        ScriptMode::DryRun => "Dry run: everything below was rolled back, nothing was kept. \
                               The counts are what each statement would change.\n"
            .to_string(),
    };
    text.push_str(&finished.lock().unwrap().join("\n"));
    text.push('\n');
    for n in &ran.notices {
        text.push_str(&format!("{}: {}\n", n.severity, n.message));
    }
    let left_open =
        ran.transaction == run::TxState::Active || ran.transaction == run::TxState::Failed;
    if left_open && mode == ScriptMode::Normal {
        text.push_str("The script left a transaction open: it was rolled back.\n");
    }
    let failed = ran.results.iter().any(|r| r.error.is_some());
    let meta = format!(
        "{}{}{}",
        match mode {
            ScriptMode::Normal => "",
            ScriptMode::ReadOnly => "read-only, ",
            ScriptMode::DryRun => "dry run, ",
        },
        plural(ran.results.len() as u64, "statement", "statements"),
        if failed { ", stopped at an error" } else { "" }
    );
    drop(client);
    // A statement that lost the connection: told as such, with what had
    // finished before it.
    let lost = ran
        .results
        .iter()
        .filter_map(|r| r.error.as_ref())
        .any(|e| match e.code.as_deref() {
            Some(code) => connection_sqlstate(code),
            None => says_network(&e.message),
        });
    if lost {
        return Err(AppError::Network(text.trim_end().to_string()));
    }
    if failed {
        return Err(invalid(text.trim_end().to_string()));
    }
    Ok(Done {
        text: text.trim_end().to_string(),
        meta,
    })
}

/// get_history: the history, as far as the client may read it.
fn get_history(call: &Call<'_>, args: &Value) -> AppResult<Done> {
    let config = call.inner.config();
    let since = match str_arg(args, "since") {
        None => None,
        Some(text) => Some(parse_since(&text)?),
    };
    let limit = int_arg(args, "limit", DEFAULT_HISTORY, MAX_HISTORY) as usize;
    let readable = |id: &String| policy::level_of(&config, id) >= Level::Read;
    let entries: Vec<HistoryEntry> = call
        .inner
        .history
        .list(&HistoryFilter {
            connection_id: str_arg(args, "connection_id"),
            since,
            limit: None,
        })?
        .into_iter()
        .filter(|e| {
            e.connection_id.as_ref().is_none_or(readable) && e.connection_ids.iter().all(readable)
        })
        .take(limit)
        .collect();
    let n = plural(entries.len() as u64, "entry", "entries");
    let mut text = match str_arg(args, "format").as_deref() {
        Some("json") => history::json(&entries),
        _ => history::markdown(&entries),
    };
    if !config.history {
        text.insert_str(
            0,
            "(The user has turned the history off in Postgres Studio: new calls aren't kept.)\n\n",
        );
    }
    Ok(Done { text, meta: n })
}

/// A date (`2026-11-16`, from midnight UTC) or an RFC 3339 date-time.
fn parse_since(text: &str) -> AppResult<u64> {
    use time::format_description::well_known::Rfc3339;
    let text = text.trim();
    let full = if text.len() == 10 {
        format!("{text}T00:00:00Z")
    } else {
        text.to_string()
    };
    time::OffsetDateTime::parse(&full, &Rfc3339)
        .map(|d| (d.unix_timestamp_nanos() / 1_000_000).max(0) as u64)
        .map_err(|_| invalid("since must be a date like 2026-11-16 or an RFC 3339 date-time."))
}

// --- Saved connections ---

fn list_connections(inner: &Inner) -> Done {
    let config = inner.config();
    let folders = crate::sidebar_layout::folder_paths(&inner.host.sidebar_layout());
    let visible: Vec<Value> = inner
        .state()
        .connection_store
        .list()
        .into_iter()
        .filter_map(|profile| {
            let level = policy::level_of(&config, &profile.id);
            if level < Level::Read {
                return None;
            }
            Some(json!({
                "id": profile.id,
                "name": profile.name,
                "folder": folders.get(&profile.id),
                "environment": profile.environment.map(Environment::id),
                "host": logging::host_summary(&profile),
                "default_database": profile.database,
                "access": if level == Level::Write { "read & write" } else { "read" },
                "read_only_role": profile.advanced.read_only,
            }))
        })
        .collect();
    let count = plural(visible.len() as u64, "connection", "connections");
    let text = if visible.is_empty() {
        "No connections are shared with MCP clients. The user can share connections in Postgres \
         Studio's settings."
            .to_string()
    } else {
        format!(
            "{count} you may use (one JSON object per line):\n{}",
            visible
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    Done { text, meta: count }
}

/// A connection's new settings from a call: all of them to create one,
/// what changes to edit one.
#[derive(Default)]
struct ConnectionArgs {
    name: Option<String>,
    source: Option<ConnectionSource>,
    database: Option<String>,
    username: Option<String>,
    /// A password was in the uri; it was dropped.
    had_password: bool,
    folder: Option<String>,
    /// Absent (`None`), cleared (`Some(None)`) or set.
    environment: Option<Option<Environment>>,
}

impl ConnectionArgs {
    /// For the approval card: what is saved, never a password.
    fn describe(&self) -> String {
        let mut lines = Vec::new();
        if let Some(name) = &self.name {
            lines.push(format!("name: {name}"));
        }
        match &self.source {
            Some(ConnectionSource::Uri { uri }) => lines.push(format!("uri: {uri}")),
            Some(ConnectionSource::Manual { host, port }) => {
                lines.push(format!("host: {host}:{port}"))
            }
            None => {}
        }
        if let Some(db) = &self.database {
            lines.push(format!("default database: {db}"));
        }
        if let Some(user) = &self.username {
            lines.push(format!("user: {user}"));
        }
        if let Some(folder) = &self.folder {
            lines.push(format!("folder: {folder}"));
        }
        if let Some(environment) = self.environment {
            lines.push(format!(
                "environment: {}",
                environment.map_or("none", Environment::id)
            ));
        }
        lines.join("\n")
    }
}

fn name_arg(args: &Value) -> Option<String> {
    str_arg(args, "name").map(|n| n.trim().chars().take(200).collect())
}

/// The connection settings of `args`; `create` needs a name and a uri or
/// host.
fn connection_args(args: &Value, create: bool) -> AppResult<ConnectionArgs> {
    let mut out = ConnectionArgs {
        name: name_arg(args).filter(|n| !n.is_empty()),
        username: str_arg(args, "username"),
        database: str_arg(args, "default_database"),
        folder: str_arg(args, "folder"),
        environment: environment_arg(args)?,
        ..ConnectionArgs::default()
    };
    if let Some(uri) = str_arg(args, "uri") {
        let uri = uri.trim();
        if !(uri.starts_with("postgres://") || uri.starts_with("postgresql://")) {
            return Err(invalid("uri must be a postgres:// or postgresql:// URI."));
        }
        let (stripped, username, password) = extract_uri_credentials(uri);
        out.source = Some(ConnectionSource::Uri { uri: stripped });
        out.had_password = password.is_some();
        if out.username.is_none() {
            out.username = username.filter(|u| !u.is_empty());
        }
    } else if let Some(host) = str_arg(args, "host") {
        let port = match args.get("port") {
            None | Some(Value::Null) => DEFAULT_PORT,
            Some(p) => p
                .as_u64()
                .or_else(|| p.as_str().and_then(|s| s.trim().parse().ok()))
                .and_then(|p| u16::try_from(p).ok())
                .ok_or_else(|| invalid("port must be a number from 1 to 65535."))?,
        };
        out.source = Some(ConnectionSource::Manual { host, port });
    }
    if create {
        if out.name.is_none() {
            return Err(invalid("name is required."));
        }
        if out.source.is_none() {
            return Err(invalid(
                "Pass a uri, or a host (with port and default_database).",
            ));
        }
    } else if out.name.is_none()
        && out.source.is_none()
        && out.username.is_none()
        && out.database.is_none()
        && out.environment.is_none()
    {
        return Err(invalid(
            "Pass what changes: name, uri, host, port, default_database, username or environment.",
        ));
    }
    Ok(out)
}

/// `environment`: absent (`None`), cleared (`Some(None)`) or set.
fn environment_arg(args: &Value) -> AppResult<Option<Option<Environment>>> {
    match args.get("environment") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) if s.trim().is_empty() || s.trim().eq_ignore_ascii_case("none") => {
            Ok(Some(None))
        }
        Some(Value::String(s)) => Environment::parse(s).map(|e| Some(Some(e))).ok_or_else(|| {
            invalid("environment must be development, testing, staging, production or none.")
        }),
        Some(_) => Err(invalid("environment must be a string.")),
    }
}

/// A client may mark a connection production, never unmark it: only the
/// user can, so an agent can't lift the check it is under.
fn check_environment_change(
    current: Option<Environment>,
    change: Option<Option<Environment>>,
) -> AppResult<()> {
    match change {
        Some(new)
            if current == Some(Environment::Production) && new != Some(Environment::Production) =>
        {
            Err(invalid(
                "This connection is marked production, and only the user can change that, in \
                 Postgres Studio.",
            ))
        }
        _ => Ok(()),
    }
}

/// The folder named `name` (its plain name or its "Parent / Child" path),
/// ignoring case: (id, path).
fn find_folder(layout: &Value, name: &str) -> Option<(String, String)> {
    fn walk(nodes: &Value, prefix: &str, name: &str) -> Option<(String, String)> {
        for node in nodes.as_array().into_iter().flatten() {
            if node.get("type").and_then(Value::as_str) != Some("folder") {
                continue;
            }
            let id = node.get("id").and_then(Value::as_str)?;
            let own = node.get("name").and_then(Value::as_str).unwrap_or_default();
            let path = format!("{prefix}{own}");
            if own.eq_ignore_ascii_case(name) || path.eq_ignore_ascii_case(name) {
                return Some((id.to_string(), path));
            }
            if let Some(found) = walk(
                node.get("children").unwrap_or(&Value::Null),
                &format!("{path} / "),
                name,
            ) {
                return Some(found);
            }
        }
        None
    }
    walk(layout.get("root").unwrap_or(&Value::Null), "", name.trim())
}

fn now_secs() -> String {
    (now_ms() / 1000).to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionEvent<'a> {
    change: &'a str,
    connection_id: &'a str,
    name: &'a str,
    folder_id: Option<&'a str>,
    level: Option<Level>,
}

fn create_connection(call: &Call<'_>, args: &Value) -> AppResult<Done> {
    let new = connection_args(args, true)?;
    let folder = new
        .folder
        .as_deref()
        .and_then(|name| find_folder(&call.inner.host.sidebar_layout(), name));
    let now = now_secs();
    let profile = ConnectionProfile {
        id: String::new(),
        name: new.name.clone().unwrap_or_default(),
        color: None,
        environment: new.environment.flatten(),
        source: new.source.clone().expect("checked by connection_args"),
        database: new.database.clone(),
        username: new.username.clone(),
        has_password: false,
        tls: Default::default(),
        ssh_tunnel: None,
        advanced: Default::default(),
        created_at: now.clone(),
        updated_at: now,
    };
    let saved = call.inner.state().connection_store.upsert(profile)?;
    // Usable right away; the frontend saves the level when it hears of it.
    call.inner
        .config
        .lock()
        .unwrap()
        .connections
        .insert(saved.id.clone(), Level::Read);
    call.inner.emit(
        CONNECTION_EVENT,
        &ConnectionEvent {
            change: "created",
            connection_id: &saved.id,
            name: &saved.name,
            folder_id: folder.as_ref().map(|(id, _)| id.as_str()),
            level: Some(Level::Read),
        },
    );
    log::info!(
        "MCP {}: saved connection \"{}\" ({}) at {}",
        call.client.name,
        saved.name,
        saved.id,
        logging::route(&saved)
    );
    let mut text = format!(
        "Saved the connection \"{}\" with id {}. You have read access to it; the user can \
         change that in Postgres Studio's settings.",
        saved.name, saved.id
    );
    match (&folder, &new.folder) {
        (Some((_, path)), _) => text.push_str(&format!(" It is in the folder \"{path}\".")),
        (None, Some(name)) => text.push_str(&format!(
            " There is no folder named \"{name}\", so it is at the top of the sidebar."
        )),
        _ => {}
    }
    if new.had_password {
        text.push_str(" The password in the uri was removed and not saved.");
    }
    if let Some(user) = &new.username {
        text.push_str(&format!(
            " It logs in as \"{user}\": if the server asks for a password, the user must open \
             the connection in Postgres Studio and enter it (passwords never go through MCP)."
        ));
    }
    Ok(Done {
        text,
        meta: saved.name,
    })
}

async fn update_connection(call: &Call<'_>, args: &Value) -> AppResult<Done> {
    let change = connection_args(args, false)?;
    let state = call.inner.state();
    let mut profile = call.target.profile.clone().expect("checked before");
    let mut notes = Vec::new();
    if let Some(name) = &change.name {
        profile.name = name.clone();
    }
    check_environment_change(profile.environment, change.environment)?;
    if let Some(environment) = change.environment {
        profile.environment = environment;
    }
    if let Some(source) = change.source {
        profile.source = source;
    }
    if change.database.is_some() {
        profile.database = change.database.clone();
    }
    if change.username.is_some() && change.username != profile.username {
        profile.username = change.username.clone();
        // The saved password belonged to the old user.
        if profile.has_password {
            profile.has_password = false;
            let _ = state
                .secret_store
                .delete(&profile.id, crate::secrets::SecretKind::Password);
        }
        notes.push(format!(
            "It now logs in as \"{}\": the user must enter the password in Postgres Studio if the server asks for one.",
            change.username.as_deref().unwrap_or_default()
        ));
    }
    if change.had_password {
        notes.push("The password in the uri was removed and not saved.".to_string());
    }
    profile.updated_at = now_secs();
    let saved = state.connection_store.upsert(profile)?;
    call.inner
        .pool
        .close(&saved.id, "the connection was edited")
        .await;
    call.inner.emit(
        CONNECTION_EVENT,
        &ConnectionEvent {
            change: "updated",
            connection_id: &saved.id,
            name: &saved.name,
            folder_id: None,
            level: None,
        },
    );
    log::info!(
        "MCP {}: edited connection \"{}\" ({}) at {}",
        call.client.name,
        saved.name,
        saved.id,
        logging::route(&saved)
    );
    let mut text = format!("Updated the connection \"{}\".", saved.name);
    for note in notes {
        text.push(' ');
        text.push_str(&note);
    }
    Ok(Done {
        text,
        meta: saved.name,
    })
}

async fn delete_connection(call: &Call<'_>) -> AppResult<Done> {
    let profile = call.target.profile.clone().expect("checked before");
    let state = call.inner.state();
    state.connection_store.delete(&profile.id)?;
    let _ = state.secret_store.delete_all(&profile.id);
    call.inner
        .pool
        .close(&profile.id, "the connection was deleted")
        .await;
    {
        let mut config = call.inner.config.lock().unwrap();
        config.connections.remove(&profile.id);
        config.always.remove(&profile.id);
    }
    call.inner.emit(
        CONNECTION_EVENT,
        &ConnectionEvent {
            change: "deleted",
            connection_id: &profile.id,
            name: &profile.name,
            folder_id: None,
            level: None,
        },
    );
    log::info!(
        "MCP {}: deleted connection \"{}\" ({})",
        call.client.name,
        profile.name,
        profile.id
    );
    Ok(Done {
        text: format!("Deleted the connection \"{}\".", profile.name),
        meta: profile.name,
    })
}

// --- Saved scripts ---

/// A script as saved: a first line naming the client, one naming its
/// database, then the content.
pub(crate) fn script_body(content: &str, database: Option<&str>, client: &str) -> String {
    let mut body = format!("-- Saved by {client} through Postgres Studio's MCP server\n");
    if let Some(db) = database {
        body.push_str(&format!("-- Database: {db}\n"));
    }
    body.push_str(content);
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body
}

/// A file name from a script name: letters, digits, spaces, `-`, `_`, `.`.
pub(crate) fn script_file_stem(name: &str) -> String {
    let name = name.trim();
    let name = name
        .strip_suffix(".sql")
        .or_else(|| name.strip_suffix(".SQL"))
        .unwrap_or(name);
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .take(80)
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        "script".to_string()
    } else {
        cleaned.to_string()
    }
}

fn save_script(call: &Call<'_>, args: &Value) -> AppResult<Done> {
    let name = name_arg(args).ok_or_else(|| invalid("name is required."))?;
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let body = script_body(
        content,
        str_arg(args, "database").as_deref(),
        &call.client.name,
    );
    let scripts = call.inner.host.saved_scripts();
    let folder = scripts
        .suggest_path()?
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| invalid("no folder for saved scripts"))?;
    let stem = script_file_stem(&name);
    let mut path = folder.join(format!("{stem}.sql"));
    let mut n = 2;
    while path.exists() {
        path = folder.join(format!("{stem} ({n}).sql"));
        n += 1;
    }
    let saved = scripts.save(Some(&path.to_string_lossy()), &body)?;
    log::info!(
        "MCP {}: saved a script to {}",
        call.client.name,
        crate::assistant::detect::display_path(&path)
    );
    Ok(Done {
        text: format!(
            "Saved the script \"{name}\" to {}. The user finds it in Postgres Studio's Saved scripts.",
            saved.path
        ),
        meta: saved.name,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::HashMap;

    use super::super::test_support::{add_session, inner, set_policy};
    use super::super::ACTIVITY_EVENT;
    use super::*;
    use crate::models::{ConnectionAdvancedOptions, TlsOptions};

    pub(crate) fn profile(id: &str, name: &str, uri: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.to_string(),
            name: name.to_string(),
            color: None,
            environment: None,
            source: ConnectionSource::Uri {
                uri: uri.to_string(),
            },
            database: None,
            username: None,
            has_password: false,
            tls: TlsOptions::default(),
            ssh_tunnel: None,
            advanced: ConnectionAdvancedOptions::default(),
            created_at: "1".to_string(),
            updated_at: "1".to_string(),
        }
    }

    pub(crate) fn config(caps: &[(&str, Policy)], connections: &[(&str, Level)]) -> McpConfig {
        McpConfig {
            enabled: true,
            port: 0,
            caps: caps.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            connections: connections
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect(),
            always: HashMap::new(),
            alerts: Default::default(),
            confirm_production: true,
            history: true,
        }
    }

    fn names(config: &McpConfig) -> Vec<String> {
        definitions(config)
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn definitions_line_up_with_the_tools() {
        let all = all_definitions();
        assert_eq!(all.len(), Tool::ALL.len());
        for (tool, def) in Tool::ALL.into_iter().zip(&all) {
            assert_eq!(def["name"], tool.name());
            assert!(def["description"].as_str().unwrap().len() > 20);
            assert_eq!(def["inputSchema"]["type"], "object");
            assert_eq!(Tool::from_name(tool.name()), Some(tool));
        }
    }

    #[test]
    fn tools_list_leaves_out_capabilities_that_are_off() {
        assert_eq!(
            names(&config(&[], &[])),
            [
                "list_databases",
                "list_schemas",
                "list_tables",
                "describe_table",
                "get_task",
                "cancel_task"
            ]
        );
        let more = names(&config(
            &[
                ("connList", Policy::Allow),
                ("read", Policy::Ask),
                ("write", Policy::Ask),
                ("saveScript", Policy::Off),
            ],
            &[],
        ));
        // run_script stays, for read-only scripts.
        for name in [
            "list_connections",
            "query",
            "explain",
            "execute",
            "run_script",
        ] {
            assert!(more.contains(&name.to_string()), "{name}");
        }
        for name in ["save_script", "run_ddl"] {
            assert!(!more.contains(&name.to_string()), "{name}");
        }
    }

    #[test]
    fn script_modes_check_what_the_script_holds() {
        let reads = "SELECT 1; WITH a AS (SELECT 2) SELECT * FROM a; EXPLAIN SELECT 3";
        assert_eq!(check_script(reads, ScriptMode::ReadOnly).unwrap(), 3);
        let err = |sql, mode| check_script(sql, mode).unwrap_err().to_string();
        assert!(err("SELECT 1; UPDATE t SET a = 1", ScriptMode::ReadOnly)
            .contains("Statement 2 is UPDATE"));
        assert!(err("SELECT pg_terminate_backend(42)", ScriptMode::ReadOnly)
            .contains("pg_terminate_backend acts on the server"));
        assert!(err("SELECT pg_terminate_backend(42)", ScriptMode::DryRun)
            .contains("pg_terminate_backend"));
        assert_eq!(
            check_script(
                "UPDATE t SET a = 1; ALTER TABLE t ADD b int",
                ScriptMode::DryRun
            )
            .unwrap(),
            2
        );
        assert!(
            err("UPDATE t SET a = 1; COMMIT", ScriptMode::DryRun).contains("Statement 2 is COMMIT")
        );
        assert!(err("COPY t TO PROGRAM 'rm -rf /'", ScriptMode::DryRun).contains("runs a program"));
        assert_eq!(
            check_script("BEGIN; UPDATE t SET a = 1; COMMIT", ScriptMode::Normal).unwrap(),
            3
        );

        assert_eq!(
            Tool::RunScript.cap_for(&json!({ "read_only": "true" })),
            Cap::Read
        );
        assert_eq!(
            Tool::RunScript.cap_for(&json!({ "dry_run": true })),
            Cap::Script
        );
        assert!(!Tool::RunScript.changes_data(&json!({ "dry_run": true })));
        assert!(Tool::RunScript.changes_data(&json!({})));
        assert!(ScriptMode::of(&json!({ "read_only": true, "dry_run": true })).is_err());
    }

    #[test]
    fn one_statement_of_the_right_kind() {
        assert!(one_statement("UPDATE t SET a = 1", &WRITE_COMMANDS, "writes").is_ok());
        let two = one_statement(
            "UPDATE t SET a = 1; COMMIT; DROP TABLE t",
            &WRITE_COMMANDS,
            "writes",
        );
        assert!(two
            .unwrap_err()
            .to_string()
            .contains("exactly one statement"));
        let ddl = one_statement("DROP TABLE t", &WRITE_COMMANDS, "writes");
        assert!(ddl.unwrap_err().to_string().contains("not DROP TABLE"));
        let (_, command) = one_statement(
            "create index concurrently i on t (a)",
            &DDL_COMMANDS,
            "schema changes",
        )
        .unwrap();
        assert_eq!(command, "CREATE INDEX");
        assert!(one_statement("SELECT 1", &DDL_COMMANDS, "schema changes").is_err());
    }

    #[test]
    fn names_what_a_write_changes() {
        assert_eq!(
            write_target("UPDATE public.customers SET x = 1", "UPDATE"),
            "UPDATE public.customers"
        );
        assert_eq!(
            write_target("delete from only orders where id = 1", "DELETE"),
            "DELETE orders"
        );
        assert_eq!(
            write_target("INSERT INTO t(a) VALUES (1)", "INSERT"),
            "INSERT t"
        );
        assert_eq!(
            write_target("WITH x AS (SELECT 1) SELECT 1", "WITH"),
            "WITH"
        );
    }

    #[test]
    fn script_names_and_bodies() {
        assert_eq!(script_file_stem("monthly report.sql"), "monthly report");
        assert_eq!(script_file_stem("a/b:c"), "a-b-c");
        assert_eq!(script_file_stem("  ..  "), "script");
        assert_eq!(
            script_body("SELECT 1;", Some("shop"), "Claude Code"),
            "-- Saved by Claude Code through Postgres Studio's MCP server\n-- Database: shop\nSELECT 1;\n"
        );
    }

    #[test]
    fn connection_arguments_never_keep_a_password() {
        let args =
            json!({ "name": "Billing", "uri": "postgres://bob:s3cret@db.internal:5433/billing" });
        let new = connection_args(&args, true).unwrap();
        assert!(new.had_password);
        assert_eq!(new.username.as_deref(), Some("bob"));
        match new.source.unwrap() {
            ConnectionSource::Uri { uri } => assert!(!uri.contains("s3cret"), "{uri}"),
            other => panic!("{other:?}"),
        }
        let manual =
            connection_args(&json!({ "name": "Local", "host": "localhost" }), true).unwrap();
        assert!(matches!(
            manual.source,
            Some(ConnectionSource::Manual { port: 5432, .. })
        ));
        assert!(connection_args(&json!({ "name": "x", "uri": "mysql://h" }), true).is_err());
        assert!(connection_args(&json!({ "name": "x" }), true).is_err());
        assert!(connection_args(&json!({}), false).is_err());
    }

    async fn run(inner: &Arc<Inner>, name: &str, args: Value) -> ToolOutput {
        let client = add_session(inner, "s1", "Test client");
        call(inner, &client, name, args).await.unwrap()
    }

    #[tokio::test]
    async fn refuses_what_is_off_or_out_of_reach() {
        let (host, inner) = inner(Duration::from_secs(1));
        host.state
            .connection_store
            .upsert(profile("c1", "Local", "postgres://localhost:1/shop"))
            .unwrap();
        set_policy(
            &inner,
            config(
                &[("read", Policy::Allow), ("write", Policy::Allow)],
                &[("c1", Level::Read)],
            ),
        );
        let off = run(
            &inner,
            "run_ddl",
            json!({ "connection_id": "c1", "database": "shop", "sql": "DROP TABLE t" }),
        )
        .await;
        assert!(off.is_error);
        assert_eq!(off.text, policy::REFUSED_OFF);
        // Writing needs Read & write on the connection.
        let no_access = run(
            &inner,
            "execute",
            json!({ "connection_id": "c1", "database": "shop", "sql": "DELETE FROM t" }),
        )
        .await;
        assert_eq!(no_access.text, policy::REFUSED_NO_ACCESS);
        let missing = run(
            &inner,
            "query",
            json!({ "connection_id": "c1", "sql": "SELECT 1" }),
        )
        .await;
        assert!(
            missing.text.contains("database is required"),
            "{}",
            missing.text
        );
        let unknown = run(
            &inner,
            "list_tables",
            json!({ "connection_id": "nope", "database": "shop" }),
        )
        .await;
        assert_eq!(unknown.text, policy::REFUSED_NO_ACCESS);
        let activity = host.events_named(ACTIVITY_EVENT);
        assert_eq!(activity.len(), 4);
        assert_eq!(activity[0]["label"], "Refused: turned off");
        assert_eq!(activity[0]["result"], "warn");
        assert_eq!(activity[0]["clientName"], "Test client");
    }

    #[tokio::test]
    async fn reads_refuse_functions_that_act_on_the_server() {
        let (host, inner) = inner(Duration::from_secs(1));
        host.state
            .connection_store
            .upsert(profile("c1", "Local", "postgres://localhost:1/shop"))
            .unwrap();
        set_policy(
            &inner,
            config(&[("read", Policy::Allow)], &[("c1", Level::Read)]),
        );
        // Refused before connecting: the address above doesn't answer.
        let mut call = Call {
            inner: &inner,
            client: &add_session(&inner, "s1", "Test client"),
            tool: Tool::Query,
            target: Target {
                database: Some("shop".into()),
                ..Target::default()
            },
            started: Instant::now(),
            task: Task::new("s1", "query", false),
            retried: false,
            code: None,
        };
        let args = json!({ "sql": "SELECT pg_terminate_backend(42)" });
        let error = plan(&mut call, &args, None)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(
            error.contains("pg_terminate_backend acts on the server"),
            "{error}"
        );
        assert!(!error.contains("Assistant"), "{error}");
    }

    #[tokio::test]
    async fn lists_only_shared_connections_without_secrets() {
        let (host, inner) = inner(Duration::from_secs(1));
        for (id, name) in [("c1", "Local"), ("c2", "Prod")] {
            host.state
                .connection_store
                .upsert(profile(
                    id,
                    name,
                    &format!("postgres://{id}.internal:5432/shop?sslmode=require"),
                ))
                .unwrap();
        }
        *host.layout.lock().unwrap() = json!({ "root": [
            { "type": "folder", "id": "f1", "name": "Remote", "children": [{ "type": "connection", "id": "c1" }] }
        ] });
        set_policy(
            &inner,
            config(
                &[("connList", Policy::Allow)],
                &[("c1", Level::Write), ("c2", Level::None)],
            ),
        );
        let out = run(&inner, "list_connections", json!({})).await;
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.contains("\"name\":\"Local\""), "{}", out.text);
        assert!(out.text.contains("\"folder\":\"Remote\""), "{}", out.text);
        assert!(out.text.contains("read & write"), "{}", out.text);
        assert!(!out.text.contains("Prod"), "{}", out.text);
        assert!(!out.text.contains("sslmode"), "{}", out.text);
    }

    #[tokio::test]
    async fn creates_edits_and_deletes_connections() {
        let (host, inner) = inner(Duration::from_secs(1));
        *host.layout.lock().unwrap() = json!({ "root": [
            { "type": "folder", "id": "f1", "name": "Remote", "children": [
                { "type": "folder", "id": "f2", "name": "EU", "children": [] }
            ] }
        ] });
        set_policy(
            &inner,
            config(
                &[("connEdit", Policy::Allow), ("connDelete", Policy::Allow)],
                &[],
            ),
        );
        let out = run(
            &inner,
            "create_connection",
            json!({ "name": "Billing", "uri": "postgresql://bob:pw@db:5432/billing", "folder": "remote / eu" }),
        )
        .await;
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.contains("removed and not saved"), "{}", out.text);
        assert!(out.text.contains("\"Remote / EU\""), "{}", out.text);
        let saved = host.state.connection_store.list();
        let created = saved.iter().find(|p| p.name == "Billing").unwrap();
        assert!(!created.has_password);
        assert_eq!(created.username.as_deref(), Some("bob"));
        assert_eq!(inner.config().connections[&created.id], Level::Read);
        let event = host.events_named(CONNECTION_EVENT).pop().unwrap();
        assert_eq!(event["change"], "created");
        assert_eq!(event["folderId"], "f2");
        assert_eq!(event["level"], "read");

        let id = created.id.clone();
        let out = run(
            &inner,
            "update_connection",
            json!({ "connection_id": id, "name": "Billing EU" }),
        )
        .await;
        assert!(!out.is_error, "{}", out.text);
        assert_eq!(
            host.state.connection_store.get(&id).unwrap().name,
            "Billing EU"
        );

        let out = run(&inner, "delete_connection", json!({ "connection_id": id })).await;
        assert!(!out.is_error, "{}", out.text);
        assert!(host.state.connection_store.get(&id).is_err());
        assert!(!inner.config().connections.contains_key(&id));
        assert_eq!(inner.pool.len().await, 0);
    }

    #[tokio::test]
    async fn saves_scripts_marked_with_the_client() {
        let (host, inner) = inner(Duration::from_secs(1));
        set_policy(&inner, config(&[("saveScript", Policy::Allow)], &[]));
        let args = json!({ "name": "Top customers", "content": "SELECT 1;", "database": "shop" });
        let first = run(&inner, "save_script", args.clone()).await;
        assert!(!first.is_error, "{}", first.text);
        let second = run(&inner, "save_script", args).await;
        assert!(
            second.text.contains("Top customers (2).sql"),
            "{}",
            second.text
        );
        let scripts = host.scripts.list().unwrap();
        assert_eq!(scripts.len(), 2);
        let body = std::fs::read_to_string(&scripts[0].path).unwrap();
        assert!(body.starts_with(
            "-- Saved by Test client through Postgres Studio's MCP server\n-- Database: shop\n"
        ));
    }

    #[test]
    fn timeouts_and_booleans_also_come_as_strings() {
        assert_eq!(statement_timeout_setting(&json!({})), "30000ms");
        assert_eq!(
            statement_timeout_setting(&json!({ "timeout_ms": "120000" })),
            "120000ms"
        );
        assert_eq!(
            statement_timeout_setting(&json!({ "timeout_ms": 9_999_999 })),
            "600000ms"
        );
        assert!(bool_arg(&json!({ "analyze": "true" }), "analyze"));
        assert!(bool_arg(&json!({ "analyze": true }), "analyze"));
        assert!(!bool_arg(&json!({ "analyze": "no" }), "analyze"));
        assert!(!bool_arg(&json!({}), "analyze"));
    }

    #[test]
    fn history_since_takes_a_date_or_a_date_time() {
        assert_eq!(parse_since("1970-01-02").unwrap(), 86_400_000);
        assert_eq!(parse_since("1970-01-01T00:00:01Z").unwrap(), 1_000);
        assert_eq!(
            parse_since("1970-01-01T00:00:01-03:00").unwrap(),
            10_801_000
        );
        assert!(parse_since("yesterday").is_err());
    }

    #[test]
    fn lost_connections_are_told_from_other_errors() {
        let reset = std::io::Error::from(std::io::ErrorKind::ConnectionReset);
        assert!(lost_connection(&AppError::Io(reset)));
        assert!(lost_connection(&AppError::InvalidInput(
            "error communicating with the server: Connection reset by peer (os error 104)".into()
        )));
        assert!(lost_connection(&AppError::Database(Box::new(DbError {
            message: "terminating connection due to administrator command".into(),
            code: Some("57P01".into()),
            detail: None,
            hint: None,
            position: None,
            severity: Some("FATAL".into()),
        }))));
        // A statement's own error, even one that sounds like it.
        assert!(!lost_connection(&AppError::Database(Box::new(DbError {
            message: "connection closed by the API".into(),
            code: Some("P0001".into()),
            detail: None,
            hint: None,
            position: None,
            severity: Some("ERROR".into()),
        }))));
        // A script's output that holds such text somewhere.
        assert!(!lost_connection(&AppError::InvalidInput(
            "1. SELECT: 1 row\n{\"note\":\"connection closed\"}\n2. INSERT failed: duplicate key"
                .into()
        )));
        assert!(!lost_connection(&AppError::NotFound(
            "no such connection".into()
        )));
    }

    /// A server that can't be reached is told as a lost connection, with
    /// what to check; a read is retried once.
    #[tokio::test]
    async fn unreachable_servers_say_to_check_the_network() {
        let (host, inner) = inner(Duration::from_secs(1));
        host.state
            .connection_store
            .upsert(profile(
                "dead",
                "Dead",
                "postgres://127.0.0.1:1/shop?connect_timeout=1",
            ))
            .unwrap();
        set_policy(
            &inner,
            config(
                &[("read", Policy::Allow), ("write", Policy::Allow)],
                &[("dead", Level::Write)],
            ),
        );
        let on = |sql: &str| json!({ "connection_id": "dead", "database": "shop", "sql": sql });
        let out = run(&inner, "query", on("SELECT 1")).await;
        assert!(out.is_error);
        assert!(
            out.text.starts_with("Lost the connection to \"Dead\""),
            "{}",
            out.text
        );
        assert!(
            out.text.contains("Check the VPN or the network"),
            "{}",
            out.text
        );
        let out = run(&inner, "execute", on("DELETE FROM t")).await;
        assert!(out.text.starts_with("Lost the connection"), "{}", out.text);
    }

    /// A change on a production connection is asked about even when
    /// allowed, "always" isn't kept, and a client can't take the
    /// connection out of production.
    #[tokio::test]
    async fn production_connections_ask_before_every_change() {
        use super::super::{RequestChoice, REQUEST_EVENT};
        let (host, inner) = inner(Duration::from_secs(5));
        let mut prod = profile("p1", "Billing", "postgres://db.example:5432/billing");
        prod.environment = Some(Environment::Production);
        host.state.connection_store.upsert(prod).unwrap();
        set_policy(
            &inner,
            config(
                &[("connEdit", Policy::Allow), ("connList", Policy::Allow)],
                &[("p1", Level::Write)],
            ),
        );
        let out = run(&inner, "list_connections", json!({})).await;
        assert!(
            out.text.contains("\"environment\":\"production\""),
            "{}",
            out.text
        );

        let waiting = {
            let inner = inner.clone();
            tokio::spawn(async move {
                run(
                    &inner,
                    "update_connection",
                    json!({ "connection_id": "p1", "name": "Billing EU" }),
                )
                .await
            })
        };
        let request = loop {
            if let Some(event) = host.events_named(REQUEST_EVENT).pop() {
                break event;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert_eq!(request["production"], true);
        policy::answer(
            &inner,
            request["requestId"].as_str().unwrap(),
            RequestChoice::Always,
        )
        .unwrap();
        let out = waiting.await.unwrap();
        assert!(!out.is_error, "{}", out.text);
        // "Always" counted as once.
        assert!(inner.config().always.is_empty());
        assert_eq!(
            host.state.connection_store.get("p1").unwrap().name,
            "Billing EU"
        );

        // Taking it out of production is refused before the user is asked.
        let before = host.events_named(REQUEST_EVENT).len();
        let out = run(
            &inner,
            "update_connection",
            json!({ "connection_id": "p1", "environment": "staging" }),
        )
        .await;
        assert!(
            out.is_error && out.text.contains("only the user can change that"),
            "{}",
            out.text
        );
        assert_eq!(host.events_named(REQUEST_EVENT).len(), before);

        // Without the setting, Allow goes through.
        let mut config = inner.config();
        config.confirm_production = false;
        set_policy(&inner, config);
        let out = run(
            &inner,
            "update_connection",
            json!({ "connection_id": "p1", "name": "Billing" }),
        )
        .await;
        assert!(!out.is_error, "{}", out.text);
        assert_eq!(host.events_named(REQUEST_EVENT).len(), before);
    }

    /// A request nobody answers within inline_wait comes back as a task
    /// that says it waits for the user; the answer arrives via get_task.
    #[tokio::test]
    async fn a_call_waiting_for_approval_goes_on_as_a_task() {
        use super::super::test_support::set_inline_wait;
        use super::super::{RequestChoice, REQUEST_CLOSED_EVENT, REQUEST_EVENT};
        let (host, mut inner) = inner(Duration::from_secs(5));
        set_inline_wait(&mut inner, Duration::from_millis(50));
        set_policy(&inner, config(&[("saveScript", Policy::Ask)], &[]));
        let args = json!({ "name": "report", "content": "SELECT 1;" });
        let out = run(&inner, "save_script", args.clone()).await;
        assert!(!out.is_error, "{}", out.text);
        assert!(
            out.text
                .starts_with("Waiting for the user to approve this in Postgres Studio"),
            "{}",
            out.text
        );
        assert!(
            out.text.contains("Don't call save_script again"),
            "{}",
            out.text
        );
        let task_id = out.text.split('"').nth(1).unwrap().to_string();

        // Still waiting: get_task says so after its wait.
        let status = run(
            &inner,
            "get_task",
            json!({ "task_id": task_id, "wait_ms": "20" }),
        )
        .await;
        assert!(
            status.text.starts_with("Waiting for the user"),
            "{}",
            status.text
        );

        let request = host.events_named(REQUEST_EVENT).pop().unwrap();
        policy::answer(
            &inner,
            request["requestId"].as_str().unwrap(),
            RequestChoice::Once,
        )
        .unwrap();
        let done = run(&inner, "get_task", json!({ "task_id": task_id })).await;
        assert!(!done.is_error, "{}", done.text);
        assert!(
            done.text.contains("(save_script) finished"),
            "{}",
            done.text
        );
        assert_eq!(host.scripts.list().unwrap().len(), 1);

        // Cancelling withdraws the card and runs nothing.
        let out = run(&inner, "save_script", args).await;
        let task_id = out.text.split('"').nth(1).unwrap().to_string();
        let cancelled = run(&inner, "cancel_task", json!({ "task_id": task_id })).await;
        assert!(
            cancelled.text.starts_with("Withdrew the request"),
            "{}",
            cancelled.text
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(
            host.events_named(REQUEST_CLOSED_EVENT).pop().unwrap()["reason"],
            "cancelled"
        );
        assert!(inner.approvals.lock().unwrap().is_empty());
        let after = run(
            &inner,
            "get_task",
            json!({ "task_id": task_id, "wait_ms": 0 }),
        )
        .await;
        assert!(
            after.is_error && after.text.contains("Cancelled"),
            "{}",
            after.text
        );
        assert_eq!(host.scripts.list().unwrap().len(), 1);

        let unknown = run(&inner, "get_task", json!({ "task_id": "nope" })).await;
        assert!(unknown.is_error);
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the dev server (docker-compose.dev.yml), in a schema of
    //! their own that they drop afterwards. Run with:
    //!   POSTGRES_STUDIO_TEST_URI=postgres://postgres:postgres@localhost:5433/shop \
    //!     cargo test --lib -- --ignored mcp_server::tools::live_tests
    use std::collections::HashMap;

    use super::super::test_support::{add_session, inner, set_policy, TestHost};
    use super::super::{RequestChoice, REQUEST_EVENT};
    use super::tests::profile;
    use super::*;

    const DB: &str = "shop";

    /// A connection "live" at Read & write with read, write, ddl and script
    /// set to `policy`, and a scratch schema.
    async fn setup(policy: Policy) -> (Arc<TestHost>, Arc<Inner>, String) {
        let uri = std::env::var("POSTGRES_STUDIO_TEST_URI")
            .expect("set POSTGRES_STUDIO_TEST_URI to run this test");
        let (host, inner) = inner(Duration::from_secs(5));
        host.state
            .connection_store
            .upsert(profile("live", "Live", &uri))
            .unwrap();
        let caps = ["read", "write", "ddl", "script"]
            .map(|c| (c.to_string(), policy))
            .into_iter()
            .collect();
        set_policy(
            &inner,
            McpConfig {
                enabled: true,
                port: 0,
                caps,
                connections: HashMap::from([("live".to_string(), Level::Write)]),
                always: HashMap::new(),
                alerts: Default::default(),
                confirm_production: true,
                history: true,
            },
        );
        let schema = format!("mcp_live_{}", uuid::Uuid::new_v4().simple());
        scratch(&inner, &format!("CREATE SCHEMA {schema}; CREATE TABLE {schema}.orders (id int PRIMARY KEY, status text); INSERT INTO {schema}.orders SELECT g, CASE WHEN g <= 3 THEN 'pending' ELSE 'shipped' END FROM generate_series(1, 10) g")).await;
        (host, inner, schema)
    }

    /// Runs `sql` outside the tools, for setting up and checking.
    async fn scratch(inner: &Arc<Inner>, sql: &str) -> Vec<String> {
        let profile = inner.state().connection_store.get("live").unwrap();
        let session = inner
            .pool
            .session(inner.host.as_ref(), &profile)
            .await
            .unwrap();
        let client = session.client(DB).await.unwrap();
        client
            .client
            .simple_query(sql)
            .await
            .unwrap()
            .into_iter()
            .filter_map(|m| match m {
                SimpleQueryMessage::Row(r) => r.get(0).map(str::to_string),
                _ => None,
            })
            .collect()
    }

    async fn run(inner: &Arc<Inner>, name: &str, args: Value) -> ToolOutput {
        let client = add_session(inner, "s1", "Live test");
        call(inner, &client, name, args).await.unwrap()
    }

    fn on(extra: Value) -> Value {
        let mut args = json!({ "connection_id": "live", "database": DB });
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        args
    }

    async fn drop_scratch(inner: &Arc<Inner>, schema: &str) {
        scratch(inner, &format!("DROP SCHEMA {schema} CASCADE")).await;
        inner.pool.close_all("the test is over").await;
    }

    async fn wait_for_request(host: &TestHost) -> Value {
        for _ in 0..400 {
            if let Some(event) = host.events_named(REQUEST_EVENT).pop() {
                return event;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no request event");
    }

    /// A dry run reports what a script would change and keeps nothing; a
    /// read-only script needs only read access and refuses writes.
    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn scripts_run_read_only_or_as_a_dry_run() {
        let (_host, inner, schema) = setup(Policy::Allow).await;
        let dry = format!(
            "UPDATE {schema}.orders SET status = 'late' WHERE status = 'pending'; \
             ALTER TABLE {schema}.orders ADD COLUMN note text; \
             SELECT count(*) AS late FROM {schema}.orders WHERE status = 'late'"
        );
        let out = run(
            &inner,
            "run_script",
            on(json!({ "sql": dry, "dry_run": true })),
        )
        .await;
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.starts_with("Dry run:"), "{}", out.text);
        assert!(out.text.contains("1. UPDATE 3"), "{}", out.text);
        assert!(out.text.contains("{\"late\":\"3\"}"), "{}", out.text);
        let kept = scratch(
            &inner,
            &format!(
                "SELECT count(*)::text || '/' || (SELECT count(*) FROM information_schema.columns \
                 WHERE table_schema = '{schema}' AND column_name = 'note') FROM {schema}.orders WHERE status = 'late'"
            ),
        )
        .await;
        assert_eq!(kept, ["0/0"]);

        // Read-only, on a connection shared read-only, with script off.
        let mut config = inner.config();
        config.connections.insert("live".into(), Level::Read);
        config.caps.insert("script".into(), Policy::Off);
        set_policy(&inner, config);
        let reads = format!("SELECT count(*) AS n FROM {schema}.orders; SHOW search_path");
        let out = run(
            &inner,
            "run_script",
            on(json!({ "sql": reads, "read_only": true })),
        )
        .await;
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.contains("{\"n\":\"10\"}"), "{}", out.text);
        let sneaky = format!(
            "WITH gone AS (DELETE FROM {schema}.orders RETURNING 1) SELECT count(*) FROM gone"
        );
        let out = run(
            &inner,
            "run_script",
            on(json!({ "sql": sneaky, "read_only": true })),
        )
        .await;
        assert!(
            out.is_error && out.text.contains("read-only transaction"),
            "{}",
            out.text
        );
        let out = run(&inner, "run_script", on(json!({ "sql": "SELECT 1" }))).await;
        assert!(out.is_error, "{}", out.text);
        drop_scratch(&inner, &schema).await;
    }

    /// One script on two targets: one approval, a result for each,
    /// "always" kept for both connections.
    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn one_script_on_several_connections() {
        let (host, inner, schema) = setup(Policy::Ask).await;
        let uri = std::env::var("POSTGRES_STUDIO_TEST_URI").unwrap();
        host.state
            .connection_store
            .upsert(profile("live2", "Live 2", &uri))
            .unwrap();
        inner
            .config
            .lock()
            .unwrap()
            .connections
            .insert("live2".into(), Level::Write);
        let args = json!({
            "targets": [
                { "connection_id": "live", "database": DB },
                { "connection_id": "live2", "database": "postgres" },
            ],
            "sql": "SELECT current_database() AS db",
        });
        let waiting = {
            let inner = inner.clone();
            let args = args.clone();
            tokio::spawn(async move { run(&inner, "run_script_on_connections", args).await })
        };
        let request = wait_for_request(&host).await;
        assert_eq!(request["connectionName"], "Live (shop), Live 2 (postgres)");
        assert_eq!(request["title"], "Run a script (2 targets)");
        policy::answer(
            &inner,
            request["requestId"].as_str().unwrap(),
            RequestChoice::Always,
        )
        .unwrap();
        let out = waiting.await.unwrap();
        assert!(!out.is_error, "{}", out.text);
        assert!(
            out.text.starts_with("Ran the script on 2 of 2 targets."),
            "{}",
            out.text
        );
        assert!(out.text.contains("{\"db\":\"shop\"}"), "{}", out.text);
        assert!(out.text.contains("{\"db\":\"postgres\"}"), "{}", out.text);
        let always = inner.config().always;
        assert!(always["live"].contains(&"script".to_string()));
        assert!(always["live2"].contains(&"script".to_string()));

        // Allowed now without asking; a read-only connection refuses a
        // normal run, and says read_only would do.
        let out = run(&inner, "run_script_on_connections", args.clone()).await;
        assert!(!out.is_error, "{}", out.text);
        assert_eq!(host.events_named(REQUEST_EVENT).len(), 1);
        inner
            .config
            .lock()
            .unwrap()
            .connections
            .insert("live2".into(), Level::Read);
        let out = run(&inner, "run_script_on_connections", args).await;
        assert!(
            out.is_error && out.text.contains("On Live 2") && out.text.contains("read_only: true"),
            "{}",
            out.text
        );
        drop_scratch(&inner, &schema).await;
    }

    /// Writes and scripts that ran are kept with their SQL; reads and
    /// refusals aren't; get_history hands them back, only for connections
    /// the client may read.
    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn the_history_keeps_what_ran() {
        let (_host, inner, schema) = setup(Policy::Allow).await;
        let update = format!("UPDATE {schema}.orders SET status = 'late' WHERE id = 1");
        run(&inner, "execute", on(json!({ "sql": update }))).await;
        run(
            &inner,
            "query",
            on(json!({ "sql": format!("SELECT * FROM {schema}.orders") })),
        )
        .await;
        let count = format!("SELECT count(*) FROM {schema}.orders");
        run(
            &inner,
            "run_script",
            on(json!({ "sql": count, "read_only": true })),
        )
        .await;
        inner
            .config
            .lock()
            .unwrap()
            .caps
            .insert("write".into(), Policy::Off);
        run(
            &inner,
            "execute",
            on(json!({ "sql": format!("DELETE FROM {schema}.orders") })),
        )
        .await;

        let entries = inner.history.list(&HistoryFilter::default()).unwrap();
        let tools: Vec<&str> = entries.iter().map(|e| e.tool.as_str()).collect();
        assert_eq!(tools, ["run_script", "execute"]);
        assert_eq!(entries[1].code, update);
        assert_eq!(entries[1].summary, "UPDATE 1");
        assert_eq!(entries[1].connection_name.as_deref(), Some("Live"));
        assert_eq!(entries[0].summary, "read-only, 1 statement");

        let out = run(
            &inner,
            "get_history",
            json!({ "limit": 2, "since": "2020-01-01" }),
        )
        .await;
        assert!(!out.is_error, "{}", out.text);
        assert!(
            out.text
                .starts_with("# Changes made through Postgres Studio's MCP server\n\n2 calls"),
            "{}",
            out.text
        );
        assert!(
            out.text.contains(&format!("```sql\n{update}\n```")),
            "{}",
            out.text
        );
        inner
            .config
            .lock()
            .unwrap()
            .connections
            .insert("live".into(), Level::None);
        let out = run(&inner, "get_history", json!({})).await;
        assert!(out.text.contains("Nothing recorded"), "{}", out.text);
        inner
            .config
            .lock()
            .unwrap()
            .connections
            .insert("live".into(), Level::Write);
        drop_scratch(&inner, &schema).await;
    }

    /// timeout_ms sets the statement timeout of a read.
    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn reads_take_a_statement_timeout() {
        let (_host, inner, schema) = setup(Policy::Allow).await;
        let slow =
            |timeout: &str| on(json!({ "sql": "SELECT pg_sleep(0.5)", "timeout_ms": timeout }));
        let out = run(&inner, "query", slow("100")).await;
        assert!(
            out.is_error && out.text.contains("statement timeout"),
            "{}",
            out.text
        );
        let out = run(&inner, "query", slow("5000")).await;
        assert!(!out.is_error, "{}", out.text);
        drop_scratch(&inner, &schema).await;
    }

    /// A read whose connection the server dropped still answers: it runs
    /// again on a fresh connection.
    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn a_read_survives_a_dropped_connection() {
        let (_host, inner, schema) = setup(Policy::Allow).await;
        let pid = scratch(&inner, "SELECT pg_backend_pid()").await.remove(0);
        let uri = std::env::var("POSTGRES_STUDIO_TEST_URI").unwrap();
        let (killer, conn) = tokio_postgres::connect(&uri, tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(conn);
        killer
            .simple_query(&format!("SELECT pg_terminate_backend({pid})"))
            .await
            .unwrap();
        let out = run(
            &inner,
            "query",
            on(json!({ "sql": format!("SELECT count(*) AS n FROM {schema}.orders") })),
        )
        .await;
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.contains("{\"n\":\"10\"}"), "{}", out.text);
        drop_scratch(&inner, &schema).await;
    }

    /// A script that outlasts inline_wait goes on in the background, with
    /// the statements it finished so far; get_task brings its result,
    /// cancel_task stops another one on the server too.
    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn long_scripts_go_on_as_tasks() {
        let (_host, mut inner, schema) = setup(Policy::Allow).await;
        super::super::test_support::set_inline_wait(&mut inner, Duration::from_millis(300));
        let script = format!(
            "UPDATE {schema}.orders SET status = 'late' WHERE id = 1; SELECT pg_sleep(0.6); \
             SELECT count(*) AS late FROM {schema}.orders WHERE status = 'late'"
        );
        let out = run(&inner, "run_script", on(json!({ "sql": script }))).await;
        assert!(out.text.starts_with("Still running after"), "{}", out.text);
        assert!(
            out.text.contains("Don't call run_script again"),
            "{}",
            out.text
        );
        assert!(out.text.contains("1. UPDATE 1"), "{}", out.text);
        let task_id = out.text.split('"').nth(1).unwrap().to_string();
        let done = run(
            &inner,
            "get_task",
            json!({ "task_id": task_id, "wait_ms": 5000 }),
        )
        .await;
        assert!(!done.is_error, "{}", done.text);
        assert!(done.text.contains("(run_script) finished"), "{}", done.text);
        assert!(done.text.contains("{\"late\":\"1\"}"), "{}", done.text);

        let sleeper = format!("SELECT pg_sleep(30) /* {schema} */");
        let out = run(&inner, "run_script", on(json!({ "sql": sleeper }))).await;
        let task_id = out.text.split('"').nth(1).unwrap().to_string();
        let stopped = run(&inner, "cancel_task", json!({ "task_id": task_id })).await;
        assert!(
            stopped.text.starts_with("Stopped run_script"),
            "{}",
            stopped.text
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
        let still = scratch(
            &inner,
            &format!(
                "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(30) /* {schema} */%' \
                 AND pid <> pg_backend_pid()"
            ),
        )
        .await;
        assert_eq!(still, ["0"]);
        drop_scratch(&inner, &schema).await;
    }

    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn browses_and_reads_in_a_read_only_transaction() {
        let (_host, inner, schema) = setup(Policy::Allow).await;
        let out = run(&inner, "list_databases", json!({ "connection_id": "live" })).await;
        assert!(out.text.contains("shop"), "{}", out.text);
        let out = run(&inner, "list_schemas", on(json!({}))).await;
        assert!(out.text.contains(&schema), "{}", out.text);
        let out = run(&inner, "list_tables", on(json!({ "schema": schema }))).await;
        assert!(
            out.text.contains(&format!("{schema}.orders")),
            "{}",
            out.text
        );
        let out = run(
            &inner,
            "describe_table",
            on(json!({ "table": format!("{schema}.orders") })),
        )
        .await;
        assert!(
            out.text.contains("id integer NOT NULL PRIMARY KEY"),
            "{}",
            out.text
        );

        let out = run(
            &inner,
            "query",
            on(json!({ "sql": format!("SELECT id, status FROM {schema}.orders ORDER BY id"), "limit": 2 })),
        )
        .await;
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.starts_with("2 rows"), "{}", out.text);
        assert!(
            out.text.contains("{\"id\":\"1\",\"status\":\"pending\"}"),
            "{}",
            out.text
        );
        assert!(out.text.contains("and more"), "{}", out.text);

        // A write hidden in a read is stopped by the server, not by reading the text.
        let out = run(
            &inner,
            "query",
            on(json!({ "sql": format!("WITH gone AS (DELETE FROM {schema}.orders RETURNING id) SELECT count(*) FROM gone") })),
        )
        .await;
        assert!(out.is_error);
        assert!(out.text.contains("read-only transaction"), "{}", out.text);
        assert_eq!(
            scratch(&inner, &format!("SELECT count(*) FROM {schema}.orders")).await,
            ["10"]
        );
        // So is a second statement that would end the read-only transaction.
        let out = run(
            &inner,
            "query",
            on(json!({ "sql": format!("SELECT 1; COMMIT; DELETE FROM {schema}.orders") })),
        )
        .await;
        assert!(out.is_error, "{}", out.text);

        let out = run(
            &inner,
            "explain",
            on(json!({ "sql": format!("SELECT * FROM {schema}.orders WHERE id = 3") })),
        )
        .await;
        assert!(out.text.contains("Plan on shop"), "{}", out.text);
        drop_scratch(&inner, &schema).await;
    }

    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn a_write_waits_for_approval_with_its_dry_run() {
        let (host, inner, schema) = setup(Policy::Ask).await;
        let sql = format!("UPDATE {schema}.orders SET status = 'done' WHERE status = 'shipped'");
        let waiting = {
            let inner = inner.clone();
            let args = on(json!({ "sql": sql }));
            tokio::spawn(async move { run(&inner, "execute", args).await })
        };
        let request = wait_for_request(&host).await;
        assert_eq!(request["capability"], "write");
        assert_eq!(request["tool"], "execute");
        assert_eq!(request["database"], DB);
        assert_eq!(request["dryRun"], "UPDATE 7 · rolled back");
        assert_eq!(request["title"], format!("UPDATE {schema}.orders"));
        // The dry run changed nothing.
        assert_eq!(
            scratch(
                &inner,
                &format!("SELECT count(*) FROM {schema}.orders WHERE status = 'done'")
            )
            .await,
            ["0"]
        );
        let id = super::super::policy::tests::request_id_of(&request);
        super::super::policy::answer(&inner, &id, RequestChoice::Once).unwrap();
        let out = waiting.await.unwrap();
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.starts_with("UPDATE 7: committed."), "{}", out.text);
        assert_eq!(
            scratch(
                &inner,
                &format!("SELECT count(*) FROM {schema}.orders WHERE status = 'done'")
            )
            .await,
            ["7"]
        );

        // Denied: nothing changes.
        host.events.lock().unwrap().clear();
        let waiting = {
            let inner = inner.clone();
            let args = on(json!({ "sql": format!("DELETE FROM {schema}.orders RETURNING id") }));
            tokio::spawn(async move { run(&inner, "execute", args).await })
        };
        let request = wait_for_request(&host).await;
        assert_eq!(request["dryRun"], "DELETE 10 · rolled back");
        let id = super::super::policy::tests::request_id_of(&request);
        super::super::policy::answer(&inner, &id, RequestChoice::Deny).unwrap();
        let out = waiting.await.unwrap();
        assert_eq!(out.text, super::super::policy::DENIED);
        assert_eq!(
            scratch(&inner, &format!("SELECT count(*) FROM {schema}.orders")).await,
            ["10"]
        );
        drop_scratch(&inner, &schema).await;
    }

    #[tokio::test]
    #[ignore = "needs POSTGRES_STUDIO_TEST_URI"]
    async fn schema_changes_and_scripts() {
        let (host, inner, schema) = setup(Policy::Allow).await;
        let out = run(
            &inner,
            "run_ddl",
            on(json!({ "sql": format!("CREATE INDEX CONCURRENTLY orders_status_idx ON {schema}.orders (status)") })),
        )
        .await;
        assert!(!out.is_error, "{}", out.text);
        assert_eq!(out.text, "CREATE INDEX: done.");
        assert_eq!(
            scratch(&inner, &format!("SELECT count(*) FROM pg_indexes WHERE schemaname = '{schema}' AND indexname = 'orders_status_idx'")).await,
            ["1"]
        );
        // A write sent as a schema change is refused before anything runs.
        let out = run(
            &inner,
            "run_ddl",
            on(json!({ "sql": format!("DELETE FROM {schema}.orders") })),
        )
        .await;
        assert!(
            out.is_error && out.text.contains("not DELETE"),
            "{}",
            out.text
        );
        // A write needs execute, and DDL can't hide behind it.
        let out = run(
            &inner,
            "execute",
            on(json!({ "sql": format!("DROP TABLE {schema}.orders") })),
        )
        .await;
        assert!(
            out.is_error && out.text.contains("not DROP TABLE"),
            "{}",
            out.text
        );

        let script = format!(
            "CREATE TABLE {schema}.notes (n int);\nINSERT INTO {schema}.notes VALUES (1), (2);\nSELECT count(*) AS n FROM {schema}.notes;\nBEGIN;\nDELETE FROM {schema}.notes;"
        );
        let out = run(&inner, "run_script", on(json!({ "sql": script }))).await;
        assert!(!out.is_error, "{}", out.text);
        assert!(out.text.contains("INSERT 2"), "{}", out.text);
        assert!(out.text.contains("{\"n\":\"2\"}"), "{}", out.text);
        assert!(out.text.contains("left a transaction open"), "{}", out.text);
        // The open transaction was rolled back with the script's connection.
        assert_eq!(
            scratch(&inner, &format!("SELECT count(*) FROM {schema}.notes")).await,
            ["2"]
        );
        let activity = host.events_named(super::super::ACTIVITY_EVENT);
        assert!(activity.iter().all(|a| !a["target"]
            .as_str()
            .unwrap_or_default()
            .contains("INSERT INTO")));
        drop_scratch(&inner, &schema).await;
    }
}
