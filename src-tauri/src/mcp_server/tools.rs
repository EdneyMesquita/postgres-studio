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

use super::policy::{self, Answer, Cap, Decision, Request};
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
use crate::models::{ConnectionProfile, ConnectionSource, DEFAULT_PORT};
use crate::pg::{catalog, run, split, DbError, PgClient, PgSession};

/// Server-side limit on reads, writes and dry runs.
const STATEMENT_TIMEOUT: &str = "30s";
/// Client-side backstop for one operation (scripts have their own timeout).
const OP_TIMEOUT: Duration = Duration::from_secs(60);
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

/// What `execute` takes: statements that change rows.
const WRITE_COMMANDS: [&str; 5] = ["INSERT", "UPDATE", "DELETE", "MERGE", "WITH"];
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
    CreateConnection,
    UpdateConnection,
    DeleteConnection,
    SaveScript,
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
    const ALL: [Tool; 14] = [
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
        Tool::CreateConnection,
        Tool::UpdateConnection,
        Tool::DeleteConnection,
        Tool::SaveScript,
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
            Tool::CreateConnection => "create_connection",
            Tool::UpdateConnection => "update_connection",
            Tool::DeleteConnection => "delete_connection",
            Tool::SaveScript => "save_script",
        }
    }

    /// The capability the tool needs.
    fn cap(self) -> Cap {
        match self {
            Tool::ListConnections => Cap::ConnList,
            Tool::ListDatabases | Tool::ListSchemas | Tool::ListTables | Tool::DescribeTable => {
                Cap::Browse
            }
            Tool::Query | Tool::Explain => Cap::Read,
            Tool::Execute => Cap::Write,
            Tool::RunDdl => Cap::Ddl,
            Tool::RunScript => Cap::Script,
            Tool::CreateConnection | Tool::UpdateConnection => Cap::ConnEdit,
            Tool::DeleteConnection => Cap::ConnDelete,
            Tool::SaveScript => Cap::SaveScript,
        }
    }

    fn scope(self) -> Scope {
        match self {
            Tool::ListConnections | Tool::CreateConnection | Tool::SaveScript => Scope::Nothing,
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
        )
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
        .filter(|(tool, _)| policy::cap_policy(config, tool.cap()) != Policy::Off)
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
    });
    vec![
        json!({
            "name": "list_connections",
            "description": "Lists the saved connections you may use: id, name, folder, host and default database, and whether you may read or also write. Never passwords or full connection strings.",
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
            }), &["sql"]),
            "annotations": read,
        }),
        json!({
            "name": "explain",
            "description": "The plan of one read statement. With analyze, it runs (read-only, then rolled back) and reports actual rows and times.",
            "inputSchema": on_database(json!({
                "sql": { "type": "string" },
                "analyze": { "type": "boolean", "default": false },
            }), &["sql"]),
            "annotations": read,
        }),
        json!({
            "name": "execute",
            "description": "Runs one INSERT, UPDATE, DELETE or MERGE and commits it. It first runs once in a transaction that is rolled back, to count the rows it changes; the user may be asked to approve it with that count. RETURNING rows come back as JSON lines.",
            "inputSchema": on_database(json!({ "sql": { "type": "string" } }), &["sql"]),
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
            "description": "Runs several SQL statements in order, each committing on its own unless the script opens a transaction, stopping at the first error. Reports what each did, with the first rows of each result. A transaction left open is rolled back.",
            "inputSchema": on_database(json!({
                "sql": { "type": "string" },
                "timeout_ms": { "type": "integer", "minimum": 1, "maximum": MAX_SCRIPT_MS, "default": DEFAULT_SCRIPT_MS },
            }), &["sql"]),
            "annotations": write,
        }),
        json!({
            "name": "create_connection",
            "description": "Saves a new connection, from a uri or a host. It's saved without a password, which the user adds in the app; you get read access to it.",
            "inputSchema": { "type": "object", "properties": {
                "name": connection_fields["name"], "uri": connection_fields["uri"], "host": connection_fields["host"],
                "port": connection_fields["port"], "default_database": connection_fields["default_database"],
                "username": connection_fields["username"],
                "folder": { "type": "string", "description": "A folder of the user's sidebar, by name." },
            }, "required": ["name"] },
            "annotations": edit,
        }),
        json!({
            "name": "update_connection",
            "description": "Renames a saved connection or changes where it connects. Passwords can't be set here.",
            "inputSchema": { "type": "object", "properties": {
                "connection_id": connection_id, "name": connection_fields["name"], "uri": connection_fields["uri"],
                "host": connection_fields["host"], "port": connection_fields["port"],
                "default_database": connection_fields["default_database"], "username": connection_fields["username"],
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
    ]
}

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
}

impl Call<'_> {
    /// Reports the call to the windows and builds the output.
    fn finish(&self, result: &str, label: String, meta: String, text: String) -> ToolOutput {
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

    fn fail(&self, error: AppError) -> ToolOutput {
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
    let mut call = Call {
        inner,
        client,
        tool,
        target: Target::default(),
        started: Instant::now(),
    };
    Some(run_call(&mut call, &args).await)
}

async fn run_call(call: &mut Call<'_>, args: &Value) -> ToolOutput {
    let tool = call.tool;
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

    let cap = tool.cap();
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

    let label = match decision {
        Decision::Allow => "Allowed",
        Decision::AllowAlways => "Allowed (always)",
        _ => {
            let request = Request {
                tool: tool.name(),
                capability: cap,
                connection_id: call.target.connection_id.clone(),
                connection_name: call.target.profile.as_ref().map(|p| p.name.clone()),
                database: call.target.database.clone(),
                title: plan.title.clone(),
                code: truncate(plan.code.clone(), MAX_CODE),
                dry_run: plan.dry_run.clone(),
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

    let timeout = match tool {
        Tool::RunScript => script_timeout(args) + Duration::from_secs(30),
        _ => OP_TIMEOUT,
    };
    let result = tokio::time::timeout(timeout, execute(call, args, session.as_deref(), &plan))
        .await
        .unwrap_or_else(|_| Err(invalid("The operation timed out.")));
    match result {
        Ok(done) => {
            call.log(label);
            call.finish("ok", label.to_string(), done.meta, done.text)
        }
        Err(e) => call.fail(e),
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
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
            let dry = write(&client, &sql, false).await?;
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
            let n = split::split(&sql).len();
            if n == 0 {
                return Err(invalid("The script holds no statement."));
            }
            call.target.detail = Some(plural(n as u64, "statement", "statements"));
            Ok(Plan {
                title: format!(
                    "A script of {}",
                    plural(n as u64, "statement", "statements")
                ),
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
            let rows = read_only_with(&client, sql, limit, STATEMENT_TIMEOUT)
                .await
                .map_err(invalid)?;
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
            let analyze = args.get("analyze").and_then(Value::as_bool) == Some(true);
            let explain = if analyze {
                format!("EXPLAIN (ANALYZE, BUFFERS) {sql}")
            } else {
                format!("EXPLAIN {sql}")
            };
            let rows = read_only_with(&client, &explain, usize::MAX, STATEMENT_TIMEOUT)
                .await
                .map_err(invalid)?;
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
            let done = write(&client, sql, true).await?;
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
            run_script(session, db, sql, script_timeout(args)).await
        }
        Tool::CreateConnection => create_connection(call, args),
        Tool::UpdateConnection => update_connection(call, args).await,
        Tool::DeleteConnection => delete_connection(call).await,
        Tool::SaveScript => save_script(call, args),
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
async fn write(client: &PgClient, sql: &str, commit: bool) -> AppResult<Written> {
    let end = if commit { "COMMIT" } else { "ROLLBACK" };
    let batch = format!(
        "BEGIN;\nSET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}';\nSET LOCAL lock_timeout = '5s';\n{sql};\n{end}"
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

/// Runs a script on a connection of its own, which closes afterwards: a
/// transaction the script leaves open rolls back with it.
async fn run_script(
    session: &PgSession,
    database: &str,
    sql: &str,
    timeout: Duration,
) -> AppResult<Done> {
    let client = session.target.open(database).await?;
    let options = run::RunOptions {
        row_limit: SHOWN_ROWS,
        pooler_mode: session.target.settings.pooler_mode,
        wrap_read_only: false,
    };
    let canceller = client.canceller();
    let ran = tokio::time::timeout(timeout, run::run_sql(&client, sql, options, None)).await;
    let Ok(ran) = ran else {
        canceller.cancel().await;
        return Err(invalid(format!(
            "The script didn't finish within {} s and was stopped.",
            timeout.as_secs()
        )));
    };
    let mut text = String::new();
    for r in &ran.results {
        text.push_str(&format!("{}. ", r.index + 1));
        match &r.error {
            Some(e) => text.push_str(&format!("{} failed: {e}\n", r.command)),
            None if r.returns_rows => {
                let names: Vec<String> = r.columns.iter().map(|c| c.name.clone()).collect();
                text.push_str(&format!(
                    "{}: {}{}\n{}\n",
                    r.command,
                    plural(r.row_count, "row", "rows"),
                    if r.truncated {
                        format!(", the first {} shown", r.rows.len())
                    } else {
                        String::new()
                    },
                    json_lines(&names, &r.rows)
                ));
            }
            None => text.push_str(&format!("{} {}\n", r.command, thousands(r.row_count))),
        }
    }
    for n in &ran.notices {
        text.push_str(&format!("{}: {}\n", n.severity, n.message));
    }
    if ran.transaction == run::TxState::Active || ran.transaction == run::TxState::Failed {
        text.push_str("The script left a transaction open: it was rolled back.\n");
    }
    let failed = ran.results.iter().any(|r| r.error.is_some());
    let meta = format!(
        "{}{}",
        plural(ran.results.len() as u64, "statement", "statements"),
        if failed { ", stopped at an error" } else { "" }
    );
    drop(client);
    if failed {
        return Err(invalid(text.trim_end().to_string()));
    }
    Ok(Done {
        text: text.trim_end().to_string(),
        meta,
    })
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
    {
        return Err(invalid(
            "Pass what changes: name, uri, host, port, default_database or username.",
        ));
    }
    Ok(out)
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
                "describe_table"
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
        for name in ["list_connections", "query", "explain", "execute"] {
            assert!(more.contains(&name.to_string()), "{name}");
        }
        for name in ["save_script", "run_ddl", "run_script"] {
            assert!(!more.contains(&name.to_string()), "{name}");
        }
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
