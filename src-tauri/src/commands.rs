use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use crate::assistant::{
    ApprovalChoice, Assistant, AssistantPolicy, AssistantStartInput, AssistantStarted,
    DetectedAgent,
};
use crate::connection::extract_uri_credentials;
use crate::connections_io;
use crate::error::{AppError, AppResult};
use crate::export;
use crate::logging::{self, logged, Op};
use crate::models::{
    validate_color, ConnectionHandle, ConnectionImportPreview, ConnectionProfile,
    ConnectionProfileInput, ConnectionProfileMeta, ConnectionSource, ConnectionTestResult,
    ConnectionsExportSummary, ConnectionsImportSummary, ExportFormat, ExportSummary,
    ImportedConnection, SecretBackendInfo, SecretBackendKind, SslMode,
};
use crate::pg::catalog::{self, DatabaseInfo, SchemaInfo, SchemaObjects, TableInfo};
use crate::pg::connect::{strip_tls_params, uri_param, Canceller};
use crate::pg::graph::{self, GraphCatalog};
use crate::pg::run::{self, BrowseInput, BrowseResult, SqlRun};
use crate::pg::{edit, PgClient, PgSession};
use crate::saved_scripts::{SavedScript, SavedScriptsStore};
use crate::secrets::SecretKind;
use crate::sidebar_layout::SidebarLayoutStore;
use crate::state::{AppState, CancelToken, RunningTask};

fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // A plain Unix-epoch-seconds timestamp; good enough for created/updated
    // bookkeeping without pulling in a datetime-formatting crate.
    format!("{}", now.as_secs())
}

/// The URI or key=value string without one parameter.
fn strip_param(uri: &str, key: &str) -> String {
    let matches = |kv: &str| kv.split('=').next().unwrap_or_default() == key;
    if uri.contains("://") {
        let Some((base, query)) = uri.split_once('?') else {
            return uri.to_string();
        };
        let kept: Vec<&str> = query.split('&').filter(|kv| !matches(kv)).collect();
        if kept.is_empty() {
            base.to_string()
        } else {
            format!("{base}?{}", kept.join("&"))
        }
    } else {
        uri.split_whitespace()
            .filter(|kv| !matches(kv))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Turns a submitted profile form into persisted metadata, writing any
/// secret fields (password, TLS/SSH passphrases) to the secret store and
/// stripping them from what gets written to `connections.json`.
async fn materialize_profile(
    state: &AppState,
    input: ConnectionProfileInput,
) -> AppResult<ConnectionProfile> {
    // Before any secret is written, so a bad color leaves nothing behind.
    validate_color(input.color.as_deref())?;
    let id = input.id.clone().unwrap_or_default();
    let id = if id.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        id
    };

    let mut tls = input.tls;
    let (source, mut username, extracted_password) = match input.source {
        ConnectionSource::Uri { uri } => {
            let uri = uri.trim().to_string();
            // TLS settings in the string move to the TLS options, which the
            // driver understands and the form shows.
            if let Some(mode) = uri_param(&uri, "sslmode") {
                tls.ssl_mode = match mode.as_str() {
                    "disable" | "allow" => SslMode::Disable,
                    "require" => SslMode::Require,
                    "verify-ca" => SslMode::VerifyCa,
                    "verify-full" => SslMode::VerifyFull,
                    _ => SslMode::Prefer,
                };
            }
            for (param, field) in [
                ("sslrootcert", &mut tls.ca_file),
                ("sslcert", &mut tls.cert_file),
                ("sslkey", &mut tls.key_file),
            ] {
                if let Some(v) = uri_param(&uri, param) {
                    *field = Some(v);
                }
            }
            let query_password = uri_param(&uri, "password");
            let without_tls = strip_tls_params(&uri);
            let without_password = strip_param(&without_tls, "password");
            let (stripped, user, pass) = extract_uri_credentials(&without_password);
            let user = user.or_else(|| uri_param(&stripped, "user"));
            (
                ConnectionSource::Uri { uri: stripped },
                user,
                pass.or(query_password),
            )
        }
        manual @ ConnectionSource::Manual { .. } => (manual, None, None),
    };
    if input.username.is_some() {
        username = input.username;
    }
    let password = input.password.or(extracted_password);

    let has_password = if let Some(password) = &password {
        state
            .secret_store
            .set(&id, SecretKind::Password, password)
            .map_err(AppError::Secret)?;
        true
    } else {
        // Editing a saved connection with the password left blank keeps the
        // one already stored, rather than silently dropping it.
        state
            .connection_store
            .get(&id)
            .is_ok_and(|saved| saved.has_password)
    };

    let mut ssh_tunnel = input.ssh_tunnel;
    if let Some(ssh) = &mut ssh_tunnel {
        if let Some(password) = &input.ssh_password {
            state
                .secret_store
                .set(&id, SecretKind::SshPassword, password)
                .map_err(AppError::Secret)?;
        }
        if let Some(passphrase) = &input.ssh_key_passphrase {
            state
                .secret_store
                .set(&id, SecretKind::SshKeyPassphrase, passphrase)
                .map_err(AppError::Secret)?;
            ssh.private_key_has_passphrase = true;
        }
    }

    let created_at = state
        .connection_store
        .get(&id)
        .map(|p| p.created_at)
        .unwrap_or_else(|_| now_iso());

    Ok(ConnectionProfile {
        id,
        name: input.name,
        color: input.color,
        source,
        database: input.database,
        username,
        has_password,
        tls,
        ssh_tunnel,
        advanced: input.advanced,
        created_at,
        updated_at: now_iso(),
    })
}

#[tauri::command]
pub fn list_connection_profiles(state: State<AppState>) -> Vec<ConnectionProfileMeta> {
    state
        .connection_store
        .list()
        .iter()
        .map(ConnectionProfileMeta::from)
        .collect()
}

#[tauri::command]
pub fn get_connection_profile(state: State<AppState>, id: String) -> AppResult<ConnectionProfile> {
    logged("get_connection_profile", state.connection_store.get(&id))
}

/// `"prod" (3f2a...)`: how log lines name a saved connection.
fn connection_label(profile: &ConnectionProfile) -> String {
    format!("\"{}\" ({})", profile.name, profile.id)
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "yes"
    } else {
        "no"
    }
}

#[tauri::command]
pub async fn save_connection_profile(
    state: State<'_, AppState>,
    input: ConnectionProfileInput,
) -> AppResult<ConnectionProfileMeta> {
    let saved = async {
        let profile = materialize_profile(&state, input).await?;
        state.connection_store.upsert(profile)
    }
    .await;
    let saved = logged("save_connection_profile", saved)?;
    log::info!(
        "saved connection {} at {}; password saved: {}",
        connection_label(&saved),
        logging::route(&saved),
        yes_no(saved.has_password)
    );
    Ok(ConnectionProfileMeta::from(&saved))
}

#[tauri::command]
pub async fn delete_connection_profile(state: State<'_, AppState>, id: String) -> AppResult<()> {
    logged(
        "delete_connection_profile",
        state.connection_store.delete(&id),
    )?;
    let _ = state.secret_store.delete_all(&id);
    log::info!("deleted connection {id}");
    Ok(())
}

#[tauri::command]
pub async fn export_connections(
    state: State<'_, AppState>,
    layout: State<'_, SidebarLayoutStore>,
    dest_path: String,
    include_secrets: bool,
    ids: Option<Vec<String>>,
) -> AppResult<ConnectionsExportSummary> {
    let mut profiles = state.connection_store.list();
    // Only the chosen ones, in the order given, when the user picked;
    // every saved one otherwise.
    if let Some(ids) = &ids {
        profiles.retain(|p| ids.contains(&p.id));
        profiles.sort_by_key(|p| ids.iter().position(|id| id == &p.id));
    }
    let folders = crate::sidebar_layout::folder_paths(&layout.get().unwrap_or_default());
    let exported = logged(
        "export_connections",
        connections_io::export_connections(
            &profiles,
            &folders,
            include_secrets,
            state.secret_store.as_ref(),
            std::path::Path::new(&dest_path),
        ),
    )?;
    log::info!(
        "exported {exported} connections; secrets included: {}",
        yes_no(include_secrets)
    );
    Ok(ConnectionsExportSummary { exported })
}

/// Lists what an import file holds, without saving anything, so the user
/// can pick which connections to import.
#[tauri::command]
pub async fn preview_connections_import(
    state: State<'_, AppState>,
    src_path: String,
) -> AppResult<Vec<ConnectionImportPreview>> {
    logged(
        "preview_connections_import",
        std::fs::read_to_string(&src_path)
            .map_err(AppError::from)
            .and_then(|raw| preview_import(&state, &raw)),
    )
}

fn preview_import(state: &AppState, raw: &str) -> AppResult<Vec<ConnectionImportPreview>> {
    let existing: std::collections::HashSet<String> = state
        .connection_store
        .list()
        .into_iter()
        .map(|p| p.name)
        .collect();
    let (format, entries) = connections_io::parse_connections_file_with_format(raw)?;
    Ok(entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| match entry {
            Ok(entry) => ConnectionImportPreview {
                index,
                exists: existing.contains(&entry.input.name),
                address: entry.address(),
                name: entry.input.name,
                warning: entry.warning,
                error: None,
                folder: entry.folder,
                format,
            },
            Err(message) => ConnectionImportPreview {
                index,
                name: String::new(),
                address: String::new(),
                warning: None,
                error: Some(message),
                exists: false,
                folder: None,
                format,
            },
        })
        .collect())
}

/// Imports the connections at `selected` positions of the file (see
/// `preview_connections_import`), or all of them when it's absent.
#[tauri::command]
pub async fn import_connections(
    state: State<'_, AppState>,
    src_path: String,
    selected: Option<Vec<usize>>,
) -> AppResult<ConnectionsImportSummary> {
    let summary = async {
        import_file(
            &state,
            &std::fs::read_to_string(&src_path)?,
            selected.as_deref(),
        )
        .await
    }
    .await;
    let summary = logged("import_connections", summary)?;
    log::info!(
        "imported {} connections, {} skipped with errors, {} with warnings",
        summary.imported,
        summary.errors.len(),
        summary.warnings.len()
    );
    // Names and what went wrong, never a connection string or password.
    for error in &summary.errors {
        log::warn!("import error: {error}");
    }
    for warning in &summary.warnings {
        log::warn!("import warning: {warning}");
    }
    Ok(summary)
}

async fn import_file(
    state: &AppState,
    raw: &str,
    selected: Option<&[usize]>,
) -> AppResult<ConnectionsImportSummary> {
    let parsed = connections_io::parse_connections_file(raw)?;

    let mut imported = 0;
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut created = Vec::new();
    for (index, entry) in parsed.into_iter().enumerate() {
        if selected.is_some_and(|picked| !picked.contains(&index)) {
            continue;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(message) => {
                errors.push(message);
                continue;
            }
        };
        if let Some(warning) = entry.warning {
            warnings.push(format!("{}: {warning}", entry.input.name));
        }
        let folder = entry.folder;
        let profile = materialize_profile(state, entry.input).await?;
        let saved = state.connection_store.upsert(profile)?;
        // Whether a password came along is what "imported connections
        // can't log in" comes down to.
        log::info!(
            "imported connection {} at {}; user set: {}, password saved: {}",
            connection_label(&saved),
            logging::route(&saved),
            yes_no(saved.username.is_some()),
            yes_no(saved.has_password)
        );
        imported += 1;
        created.push(ImportedConnection {
            id: saved.id,
            folder,
        });
    }

    Ok(ConnectionsImportSummary {
        imported,
        errors,
        warnings,
        created,
    })
}

#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    input: ConnectionProfileInput,
) -> AppResult<ConnectionTestResult> {
    test_profile(&state, input).await
}

/// Tests the connection a form describes without touching saved secrets.
///
/// Materializing a profile writes its secrets to the store, so doing that
/// under the profile's own id would overwrite a saved password with
/// whatever was typed into an edit form that is then cancelled - and a
/// never-saved connection would leave its secrets behind. Instead the test
/// runs under a throwaway id, borrowing the saved secrets the form left
/// blank, and everything stored under that id is removed afterwards.
async fn test_profile(
    state: &AppState,
    mut input: ConnectionProfileInput,
) -> AppResult<ConnectionTestResult> {
    let saved = input
        .id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| state.connection_store.get(id).ok());
    let temp_id = format!("connection-test-{}", Uuid::new_v4());
    let label = format!(
        "\"{}\" ({})",
        input.name,
        saved.as_ref().map_or("unsaved", |s| s.id.as_str())
    );
    let started = Instant::now();

    let result = async {
        if let Some(saved) = &saved {
            for kind in SecretKind::ALL {
                if let Some(value) = state
                    .secret_store
                    .get(&saved.id, kind)
                    .map_err(AppError::Secret)?
                {
                    state
                        .secret_store
                        .set(&temp_id, kind, &value)
                        .map_err(AppError::Secret)?;
                }
            }
        }
        input.id = Some(temp_id.clone());
        let mut profile = materialize_profile(state, input).await?;
        // A blank password field means the saved one, copied over above.
        profile.has_password |= saved.as_ref().is_some_and(|s| s.has_password);
        let tested = crate::pg::connect::test_connection(
            &profile,
            state.secret_store.as_ref(),
            &state.known_hosts,
        )
        .await;
        let tested = match tested {
            Ok(version) => ConnectionTestResult {
                success: true,
                message: "Connected successfully".to_string(),
                server_version: version,
            },
            Err(e) => ConnectionTestResult {
                success: false,
                message: e.to_string(),
                server_version: None,
            },
        };
        Ok((tested, logging::route(&profile)))
    }
    .await;

    let _ = state.secret_store.delete_all(&temp_id);
    let ms = started.elapsed().as_millis();
    let (tested, route) = logged(&format!("testing connection {label}"), result)?;
    if tested.success {
        log::info!(
            "connection test of {label} at {route} succeeded in {ms} ms; server {}",
            tested
                .server_version
                .as_deref()
                .unwrap_or("version unknown")
        );
    } else {
        log::warn!(
            "connection test of {label} at {route} failed after {ms} ms: {}",
            logging::scrub_credentials(&tested.message)
        );
    }
    Ok(tested)
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> AppResult<ConnectionHandle> {
    let profile = logged("connect", state.connection_store.get(&id))?;
    let target = format!(
        "{} at {}",
        connection_label(&profile),
        logging::route(&profile)
    );
    log::info!("connecting to {target}");
    let started = Instant::now();
    let session =
        PgSession::connect(&profile, state.secret_store.as_ref(), &state.known_hosts).await;
    let ms = started.elapsed().as_millis();
    let session = logged(&format!("connecting to {target} ({ms} ms)"), session)?;
    let server_version = session.server_version.clone();
    let database = session.target.default_db.clone();
    let settings = session.target.settings.clone();

    let session_id = Uuid::new_v4().to_string();
    log::info!(
        "connected to {target} in {} ms; server {}; session {session_id}",
        started.elapsed().as_millis(),
        server_version.as_deref().unwrap_or("version unknown")
    );
    state
        .sessions
        .write()
        .await
        .insert(session_id.clone(), Arc::new(session));

    Ok(ConnectionHandle {
        session_id,
        server_version,
        database,
        read_only: settings.read_only,
        pooler_mode: settings.pooler_mode,
        show_system_schemas: profile.advanced.show_system_schemas,
    })
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    let session = state.sessions.write().await.remove(&session_id);
    match session {
        Some(session) => {
            session.shutdown().await;
            log::info!("disconnected \"{}\"; session {session_id}", session.name);
            Ok(())
        }
        None => logged("disconnect", Err(AppError::SessionNotFound(session_id))),
    }
}

#[tauri::command]
pub fn secret_backend_info(state: State<AppState>) -> SecretBackendInfo {
    let warning = match state.secret_backend {
        SecretBackendKind::Keyring => None,
        SecretBackendKind::EncryptedFile => Some(
            "No OS keychain was found (common on headless Linux). Secrets are encrypted at \
             rest on disk instead, which is less secure than a real system keychain."
                .to_string(),
        ),
    };
    SecretBackendInfo {
        backend: state.secret_backend,
        warning,
    }
}

/// The live session behind `session_id`.
pub(crate) async fn session(state: &AppState, session_id: &str) -> AppResult<Arc<PgSession>> {
    state
        .sessions
        .read()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))
}

/// Runs a database operation, logging it if it fails or is slow.
pub(crate) async fn on_session<T>(
    state: &AppState,
    session_id: &str,
    op: Op<'_>,
    run: impl AsyncFnOnce(Arc<PgSession>) -> AppResult<T>,
) -> AppResult<T> {
    let found = session(state, session_id).await;
    let connection = found
        .as_ref()
        .map_or("not connected".to_string(), |s| s.name.clone());
    logging::timed(&op, &connection, async {
        let session = found?;
        run(session).await
    })
    .await
}

/// Registers what stops `execution_id`; `forget_task` removes it.
pub(crate) fn track_task(
    state: &AppState,
    execution_id: &str,
    canceller: Option<Canceller>,
) -> CancelToken {
    let token = CancelToken::default();
    state.running_tasks.lock().unwrap().insert(
        execution_id.to_string(),
        RunningTask {
            token: token.clone(),
            canceller,
        },
    );
    token
}

pub(crate) fn forget_task(state: &AppState, execution_id: &str) {
    state.running_tasks.lock().unwrap().remove(execution_id);
}

/// Runs `task` on `client` so that `cancel_query(execution_id)` stops it,
/// on the server too.
async fn cancellable<T>(
    state: &AppState,
    execution_id: Option<&str>,
    client: &PgClient,
    task: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    let Some(id) = execution_id else {
        return task.await;
    };
    let token = track_task(state, id, Some(client.canceller()));
    let result = token.guard(task).await;
    forget_task(state, id);
    result
}

/// Stops what runs under this execution id, on the server too.
#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, execution_id: String) -> AppResult<()> {
    let task = state
        .running_tasks
        .lock()
        .unwrap()
        .get(&execution_id)
        .map(|t| (t.token.clone(), t.canceller.clone()));
    if let Some((token, canceller)) = task {
        if let Some(canceller) = canceller {
            canceller.cancel().await;
        }
        token.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<DatabaseInfo>> {
    let op = Op::new("listDatabases", "", None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&s.target.default_db).await?;
        catalog::list_databases(&client).await
    })
    .await
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Vec<SchemaInfo>> {
    let op = Op::new("listSchemas", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        catalog::list_schemas(&client).await
    })
    .await
}

#[tauri::command]
pub async fn list_schema_objects(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
) -> AppResult<SchemaObjects> {
    let op = Op::new("listObjects", &database, Some(&schema));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        catalog::list_schema_objects(&client, &schema).await
    })
    .await
}

#[tauri::command]
pub async fn schema_diagram(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
) -> AppResult<catalog::SchemaDiagram> {
    let op = Op::new("schemaDiagram", &database, Some(&schema));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        catalog::schema_diagram(&client, &schema).await
    })
    .await
}

/// Writes a schema diagram the page drew. Only an `.svg` file, and only SVG:
/// the page can't use it to write anything else anywhere.
#[tauri::command]
pub async fn save_svg(path: String, contents: String) -> AppResult<()> {
    let dest = std::path::Path::new(&path);
    if !dest
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("svg"))
    {
        return Err(AppError::InvalidInput("the file must end in .svg".into()));
    }
    if !contents.trim_start().starts_with("<svg") {
        return Err(AppError::InvalidInput("not an SVG document".into()));
    }
    logged(
        "save_svg",
        std::fs::write(dest, contents).map_err(AppError::from),
    )
}

#[tauri::command]
pub async fn describe_table(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
    table: String,
) -> AppResult<TableInfo> {
    let target = format!("{schema}.{table}");
    let op = Op::new("describe", &database, Some(&target));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        catalog::describe_table(&client, &schema, &table).await
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn object_definition(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
    name: String,
    kind: String,
    function_oid: Option<i64>,
) -> AppResult<String> {
    let target = format!("{schema}.{name}");
    let op = Op::new("definition", &database, Some(&target));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        catalog::object_definition(&client, &schema, &name, &kind, function_oid).await
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browse_table(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
    table: String,
    input: BrowseInput,
    execution_id: Option<String>,
) -> AppResult<BrowseResult> {
    let target = format!("{schema}.{table}");
    let op = Op::new("browse", &database, Some(&target));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        cancellable(
            &state,
            execution_id.as_deref(),
            &client,
            run::browse(&client, &schema, &table, &input),
        )
        .await
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn count_rows(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
    table: String,
    where_clause: Option<String>,
    execution_id: Option<String>,
) -> AppResult<i64> {
    let target = format!("{schema}.{table}");
    let op = Op::new("count", &database, Some(&target));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        cancellable(
            &state,
            execution_id.as_deref(),
            &client,
            run::count(&client, &schema, &table, where_clause.as_deref()),
        )
        .await
    })
    .await
}

/// Runs SQL on the tab's own connection, so its transaction and settings
/// carry over between runs.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_sql(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    tab_id: String,
    sql: String,
    caret: Option<usize>,
    row_limit: Option<usize>,
    execution_id: Option<String>,
) -> AppResult<SqlRun> {
    // The SQL and its results are the user's: only where it ran, how long
    // it took and whether it failed are logged.
    let op = Op::new("sql", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.pinned(&tab_id, &database).await?;
        let settings = &s.target.settings;
        let options = run::RunOptions {
            row_limit: row_limit.unwrap_or(1000).clamp(1, 100_000),
            pooler_mode: settings.pooler_mode,
            wrap_read_only: settings.pooler_mode && settings.read_only,
        };
        let run = cancellable(&state, execution_id.as_deref(), &client, async {
            Ok(run::run_sql(&client, &sql, options, caret).await)
        })
        .await?;
        if let Some(failed) = run.results.iter().find_map(|r| r.error.as_ref()) {
            log::warn!(
                "{} [{}] statement failed: {}",
                Op::new("sql", &database, None),
                s.name,
                failed
                    .code
                    .as_deref()
                    .map_or("client error".to_string(), |c| format!("SQLSTATE {c}"))
            );
        }
        Ok(run)
    })
    .await
}

/// Runs a console's SQL through psql instead of the built-in engine: the
/// same results, plus psql's output streamed as `psql-log` events. The
/// script and what it prints stay out of the log, as with `run_sql`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn run_psql<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    sql: String,
    row_limit: Option<usize>,
    execution_id: String,
    options: crate::psql::PsqlOptions,
) -> AppResult<SqlRun> {
    let op = Op::new("sql (psql)", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let cancel = track_task(&state, &execution_id, None);
        let emit_id = execution_id.clone();
        let result = crate::psql::run(
            s,
            &database,
            &sql,
            &options,
            row_limit.unwrap_or(1000).clamp(1, 100_000),
            &execution_id,
            &cancel,
            |line| {
                let _ = tauri::Emitter::emit(
                    &app,
                    crate::psql::LOG_EVENT,
                    serde_json::json!({ "executionId": emit_id, "line": line }),
                );
            },
        )
        .await;
        forget_task(&state, &execution_id);
        result
    })
    .await
}

/// Where psql is: the picked executable, else the newest one found.
#[tauri::command]
pub async fn psql_detect(custom_path: Option<String>) -> crate::psql::PsqlInfo {
    crate::psql::detect(custom_path.as_deref()).await
}

/// Closes a tab's own connection; an open transaction on it rolls back.
#[tauri::command]
pub async fn release_tab(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
) -> AppResult<()> {
    if let Ok(s) = session(&state, &session_id).await {
        s.release(&tab_id).await;
        s.release(&format!("edit:{tab_id}")).await;
    }
    Ok(())
}

/// Where a tab's own connection stands: idle, in a transaction, or failed.
#[tauri::command]
pub async fn tab_transaction(
    state: State<'_, AppState>,
    session_id: String,
    tab_id: String,
) -> AppResult<run::TxState> {
    let s = session(&state, &session_id).await?;
    if s.target.settings.pooler_mode {
        return Ok(run::TxState::Unknown);
    }
    match s.pinned_if_open(&tab_id).await {
        Some(client) => Ok(run::transaction_state(&client).await),
        None => Ok(run::TxState::Idle),
    }
}

/// Applies a table's pending changes in one transaction.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn apply_edits(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
    table: String,
    tab_id: String,
    edits: Vec<edit::RowEdit>,
) -> AppResult<edit::ApplyResult> {
    let target = format!("{schema}.{table}");
    let op = Op::new("applyEdits", &database, Some(&target));
    on_session(&state, &session_id, op, async |s| {
        if s.target.settings.read_only {
            return Err(AppError::InvalidInput(
                "This connection is read-only. Edit the connection to allow changes.".to_string(),
            ));
        }
        // A connection of the tab's own: the transaction must not interleave
        // with anyone else's statements.
        let client = s.pinned(&format!("edit:{tab_id}"), &database).await?;
        let applied = edit::apply(&client, &schema, &table, &edits).await?;
        log::info!(
            "{} [{}] applied {} changes",
            Op::new("applyEdits", &database, Some(&target)),
            s.name,
            edits.len()
        );
        Ok(applied)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn explain_sql(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    tab_id: String,
    sql: String,
    analyze: bool,
    execution_id: Option<String>,
) -> AppResult<run::ExplainResult> {
    let op = Op::new("explain", &database, None);
    on_session(&state, &session_id, op, async |s| {
        // Its own connection, so the BEGIN/ROLLBACK around ANALYZE never
        // touches a transaction the user has open in the tab.
        let client = s.pinned(&format!("explain:{tab_id}"), &database).await?;
        cancellable(
            &state,
            execution_id.as_deref(),
            &client,
            run::explain(&client, &sql, analyze),
        )
        .await
    })
    .await
}

/// Streams a whole query to a file.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_query<R: Runtime>(
    state: State<'_, AppState>,
    app: AppHandle<R>,
    session_id: String,
    database: String,
    sql: String,
    format: ExportFormat,
    dest_path: String,
    execution_id: String,
) -> AppResult<ExportSummary> {
    let s = logged("export_query", session(&state, &session_id).await)?;
    // Its own connection: an export can run for minutes.
    let key = format!("export:{execution_id}");
    let client = logged("export_query", s.pinned(&key, &database).await)?;
    let token = track_task(&state, &execution_id, Some(client.canceller()));
    let progress_id = execution_id.clone();
    let on_progress = move |rows_written: u64| {
        let _ = app.emit(
            "export-progress",
            serde_json::json!({ "executionId": progress_id, "rowsWritten": rows_written }),
        );
    };
    let started = Instant::now();
    let result = export::export_query(
        &client,
        &sql,
        format,
        std::path::Path::new(&dest_path),
        s.target.settings.pooler_mode,
        token.flag(),
        on_progress,
    )
    .await;
    forget_task(&state, &execution_id);
    s.release(&key).await;
    let op = Op::new("export", &database, None);
    match &result {
        Ok(summary) => log::info!(
            "{op} [{}] wrote {} rows in {} ms",
            s.name,
            summary.rows_written,
            started.elapsed().as_millis()
        ),
        Err(e) => logging::op_failed(&op, &s.name, started.elapsed(), e),
    }
    result
}

/// Writes rows the frontend already holds, such as a console result.
#[tauri::command]
pub async fn export_rows(
    columns: Vec<run::ResultColumn>,
    rows: Vec<Vec<Option<String>>>,
    format: ExportFormat,
    dest_path: String,
) -> AppResult<ExportSummary> {
    let result = tokio::task::spawn_blocking(move || {
        export::export_rows(&columns, &rows, format, std::path::Path::new(&dest_path))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("export failed: {e}")))
    .flatten();
    logged("export_rows", result)
}

/// The sidebar's folder tree, or null before one was saved.
#[tauri::command]
pub async fn get_sidebar_layout(
    store: State<'_, SidebarLayoutStore>,
) -> AppResult<serde_json::Value> {
    logged("get_sidebar_layout", store.get())
}

#[tauri::command]
pub async fn save_sidebar_layout(
    store: State<'_, SidebarLayoutStore>,
    layout: serde_json::Value,
) -> AppResult<()> {
    logged("save_sidebar_layout", store.save(&layout))
}

#[tauri::command]
pub async fn suggest_script_path(store: State<'_, SavedScriptsStore>) -> AppResult<String> {
    logged(
        "suggest_script_path",
        store
            .suggest_path()
            .map(|path| path.to_string_lossy().into_owned()),
    )
}

/// Saves a console script. With no `path` it lands in the default folder
/// under a random name - what happens when the save dialog is dismissed.
#[tauri::command]
pub async fn save_script(
    store: State<'_, SavedScriptsStore>,
    path: Option<String>,
    content: String,
) -> AppResult<SavedScript> {
    logged("save_script", store.save(path.as_deref(), &content))
}

#[tauri::command]
pub async fn list_saved_scripts(
    store: State<'_, SavedScriptsStore>,
) -> AppResult<Vec<SavedScript>> {
    logged("list_saved_scripts", store.list())
}

#[tauri::command]
pub async fn read_saved_script(
    store: State<'_, SavedScriptsStore>,
    path: String,
) -> AppResult<String> {
    logged("read_saved_script", store.read(&path))
}

/// Finds the agent CLIs (Claude Code, Codex) and their versions.
#[tauri::command]
pub async fn assistant_detect(assistant: State<'_, Assistant>) -> AppResult<Vec<DetectedAgent>> {
    Ok(assistant.detect().await)
}

/// What the Assistant's tools may read; set at startup and whenever the
/// settings change.
#[tauri::command]
pub fn assistant_set_policy(assistant: State<Assistant>, policy: AssistantPolicy) -> AppResult<()> {
    assistant.set_policy(policy);
    Ok(())
}

/// Registers a conversation bound to one connection and database. Spawns
/// nothing until the first `assistant_send`.
#[tauri::command]
pub async fn assistant_start(
    assistant: State<'_, Assistant>,
    input: AssistantStartInput,
) -> AppResult<AssistantStarted> {
    logged("assistant_start", assistant.start(input).await)
}

/// Starts a turn; returns once the prompt is handed to the CLI. The answer
/// arrives as `assistant-event`s.
#[tauri::command]
pub async fn assistant_send(
    assistant: State<'_, Assistant>,
    agent_session_id: String,
    text: String,
) -> AppResult<()> {
    logged(
        "assistant_send",
        assistant.send(&agent_session_id, text).await,
    )
}

#[tauri::command]
pub async fn assistant_stop(
    assistant: State<'_, Assistant>,
    agent_session_id: String,
) -> AppResult<()> {
    logged("assistant_stop", assistant.stop(&agent_session_id).await)
}

#[tauri::command]
pub async fn assistant_close(
    assistant: State<'_, Assistant>,
    agent_session_id: String,
) -> AppResult<()> {
    logged("assistant_close", assistant.close(&agent_session_id).await)
}

#[tauri::command]
pub fn assistant_answer(
    assistant: State<Assistant>,
    request_id: String,
    choice: ApprovalChoice,
) -> AppResult<()> {
    logged("assistant_answer", assistant.answer(&request_id, choice))
}

/// The folder the agents run in, for the "Copy resume command" action.
#[tauri::command]
pub fn assistant_workdir(assistant: State<Assistant>) -> AppResult<String> {
    logged("assistant_workdir", assistant.workdir())
}

/// Opens the folder holding the app's log files in the OS file manager, and
/// returns its path. The error names the path too, so the user can still
/// find the folder when no file manager opens.
#[tauri::command]
pub async fn open_log_dir<R: Runtime>(app: AppHandle<R>) -> AppResult<String> {
    let opened = (|| {
        let dir = crate::logging::log_dir(&app).map_err(std::io::Error::other)?;
        std::fs::create_dir_all(&dir)?;
        let dir = dir.to_string_lossy().into_owned();
        app.opener().open_path(&dir, None::<&str>).map_err(|e| {
            std::io::Error::other(format!("couldn't open the logs folder ({dir}): {e}"))
        })?;
        Ok(dir)
    })();
    logged("open_log_dir", opened)
}

/// The graphs and graph/vector features of a database, for the explorer.
#[tauri::command]
pub async fn graph_catalog(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<GraphCatalog> {
    let op = Op::new("graphCatalog", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        graph::graph_catalog(&client).await
    })
    .await
}

/// The property names the rows of one graph label carry, for completion.
#[tauri::command]
pub async fn graph_label_properties(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    graph: String,
    label: String,
) -> AppResult<Vec<String>> {
    let op = Op::new("graphLabelProperties", &database, Some(&graph));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        graph::label_properties(&client, &graph, &label).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use tokio::sync::RwLock;

    use super::*;
    use crate::connection::ConnectionStore;
    use crate::secrets::{InMemoryStore, SecretStore};
    use crate::ssh_tunnel::KnownHosts;

    /// Lets a test keep a handle on the store AppState owns.
    struct Shared(Arc<InMemoryStore>);

    impl SecretStore for Shared {
        fn set(&self, id: &str, kind: SecretKind, value: &str) -> Result<(), String> {
            self.0.set(id, kind, value)
        }
        fn get(&self, id: &str, kind: SecretKind) -> Result<Option<String>, String> {
            self.0.get(id, kind)
        }
        fn delete(&self, id: &str, kind: SecretKind) -> Result<(), String> {
            self.0.delete(id, kind)
        }
    }

    fn state() -> (AppState, Arc<InMemoryStore>, PathBuf) {
        let dir = std::env::temp_dir().join(format!("postgres-studio-commands-{}", Uuid::new_v4()));
        let secrets = Arc::new(InMemoryStore::new());
        let state = AppState {
            connection_store: ConnectionStore::load(&dir).unwrap(),
            secret_store: Box::new(Shared(secrets.clone())),
            secret_backend: SecretBackendKind::Keyring,
            known_hosts: Arc::new(KnownHosts::load(&dir).unwrap()),
            sessions: RwLock::new(HashMap::new()),
            running_tasks: Mutex::new(HashMap::new()),
        };
        (state, secrets, dir)
    }

    /// A server that refuses at once, so tests that try to connect fail fast.
    fn input(id: Option<String>, name: &str, password: Option<&str>) -> ConnectionProfileInput {
        ConnectionProfileInput {
            id,
            name: name.to_string(),
            color: None,
            source: ConnectionSource::Uri {
                uri: "postgres://127.0.0.1:1/shop?connect_timeout=1".to_string(),
            },
            database: None,
            username: Some("alice".to_string()),
            password: password.map(str::to_string),
            tls: crate::models::TlsOptions::default(),
            ssh_tunnel: None,
            ssh_password: None,
            ssh_key_passphrase: None,
            advanced: crate::models::ConnectionAdvancedOptions::default(),
        }
    }

    async fn save(state: &AppState, input: ConnectionProfileInput) -> ConnectionProfile {
        let profile = materialize_profile(state, input).await.unwrap();
        state.connection_store.upsert(profile).unwrap()
    }

    const THREE_CONNECTIONS: &str = r#"{
        "type": "Postgres Studio Connections",
        "version": 1,
        "connections": [
            { "name": "One", "source": { "kind": "uri", "uri": "postgres://bob:pw@one.example.net/shop" } },
            { "name": "prod", "source": { "kind": "manual", "host": "two.example.net", "port": 5432 } },
            { "name": "Three", "source": { "kind": "uri", "uri": "postgres://three.example.net/" } }
        ]
    }"#;

    #[tokio::test]
    async fn uri_settings_move_to_the_profile() {
        let (state, secrets, dir) = state();
        let mut with_params = input(None, "remote", None);
        with_params.username = None;
        with_params.source = ConnectionSource::Uri {
            uri: "postgresql://alice:s%40cret@db.example.com:6543/shop?sslmode=verify-full&sslrootcert=/ca.pem&application_name=x".to_string(),
        };
        let saved = save(&state, with_params).await;
        let ConnectionSource::Uri { uri } = &saved.source else {
            panic!()
        };
        assert_eq!(
            uri,
            "postgresql://db.example.com:6543/shop?application_name=x"
        );
        assert_eq!(saved.username.as_deref(), Some("alice"));
        assert_eq!(saved.tls.ssl_mode, SslMode::VerifyFull);
        assert_eq!(saved.tls.ca_file.as_deref(), Some("/ca.pem"));
        assert_eq!(
            secrets
                .get(&saved.id, SecretKind::Password)
                .unwrap()
                .as_deref(),
            Some("s@cret")
        );

        let mut kv = input(None, "kv", None);
        kv.username = None;
        kv.source = ConnectionSource::Uri {
            uri: "host=db user=bob password=pw dbname=shop sslmode=disable".to_string(),
        };
        let saved = save(&state, kv).await;
        let ConnectionSource::Uri { uri } = &saved.source else {
            panic!()
        };
        assert_eq!(uri, "host=db user=bob dbname=shop");
        assert_eq!(saved.username.as_deref(), Some("bob"));
        assert_eq!(saved.tls.ssl_mode, SslMode::Disable);
        assert!(saved.has_password);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn preview_lists_the_file_without_saving_and_flags_existing_names() {
        let (state, _, dir) = state();
        save(&state, input(None, "prod", None)).await;

        let preview = preview_import(&state, THREE_CONNECTIONS).unwrap();

        let names: Vec<_> = preview.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["One", "prod", "Three"]);
        assert_eq!(
            preview.iter().map(|p| p.exists).collect::<Vec<_>>(),
            [false, true, false]
        );
        assert!(!preview[0].address.contains("pw"), "credentials are masked");
        assert_eq!(state.connection_store.list().len(), 1, "nothing saved");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn import_takes_only_the_selected_connections() {
        let (state, _, dir) = state();

        let summary = import_file(&state, THREE_CONNECTIONS, Some(&[0, 2]))
            .await
            .unwrap();

        assert_eq!(summary.imported, 2);
        let mut names: Vec<_> = state
            .connection_store
            .list()
            .into_iter()
            .map(|p| p.name)
            .collect();
        names.sort();
        assert_eq!(names, ["One", "Three"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn a_saved_color_round_trips_through_get_and_list() {
        let (state, _, dir) = state();
        let mut with_color = input(None, "prod", None);
        with_color.color = Some("#E5484D".to_string());

        let saved = save(&state, with_color).await;

        let fetched = state.connection_store.get(&saved.id).unwrap();
        assert_eq!(fetched.color.as_deref(), Some("#E5484D"));
        let meta: Vec<_> = state
            .connection_store
            .list()
            .iter()
            .map(ConnectionProfileMeta::from)
            .collect();
        assert_eq!(meta[0].color.as_deref(), Some("#E5484D"));
        let json = serde_json::to_value(&meta[0]).unwrap();
        assert_eq!(json["color"], "#E5484D");

        // back to automatic
        let mut cleared = input(Some(saved.id.clone()), "prod", None);
        cleared.color = None;
        assert_eq!(save(&state, cleared).await.color, None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn saving_rejects_a_color_that_is_not_hex() {
        let (state, secrets, dir) = state();
        for bad in ["red", "#E5484", "#E5484DFF", "E5484D1", "#GGGGGG", ""] {
            let mut bad_input = input(None, "prod", Some("pw"));
            bad_input.color = Some(bad.to_string());
            let err = materialize_profile(&state, bad_input).await.unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)), "{bad}: {err}");
        }
        assert_eq!(secrets.len(), 0, "no secrets written for a rejected save");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn editing_with_the_password_left_blank_keeps_the_saved_one() {
        let (state, _, dir) = state();
        let saved = save(&state, input(None, "prod", Some("s3cret"))).await;

        let edited = save(
            &state,
            input(Some(saved.id.clone()), "prod (renamed)", None),
        )
        .await;

        assert_eq!(edited.name, "prod (renamed)");
        assert!(edited.has_password);
        assert_eq!(
            state
                .secret_store
                .get(&saved.id, SecretKind::Password)
                .unwrap()
                .as_deref(),
            Some("s3cret")
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn testing_an_edit_leaves_saved_secrets_alone() {
        let (state, secrets, dir) = state();
        let saved = save(&state, input(None, "prod", Some("s3cret"))).await;
        let before = secrets.len();

        // a wrong password typed into the edit form, then tested
        test_profile(&state, input(Some(saved.id.clone()), "prod", Some("wrong")))
            .await
            .unwrap();

        assert_eq!(
            state
                .secret_store
                .get(&saved.id, SecretKind::Password)
                .unwrap()
                .as_deref(),
            Some("s3cret")
        );
        assert_eq!(secrets.len(), before, "nothing left under the throwaway id");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn testing_a_new_connection_leaves_no_secrets_behind() {
        let (state, secrets, dir) = state();

        test_profile(&state, input(None, "draft", Some("pw")))
            .await
            .unwrap();

        assert_eq!(secrets.len(), 0);
        assert!(state.connection_store.list().is_empty());
        std::fs::remove_dir_all(dir).ok();
    }
}
