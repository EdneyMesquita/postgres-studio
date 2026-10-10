//! Commands for the objects around tables: extensions, the server's
//! activity, roles and maintenance. The reads and statements themselves
//! live in `pg::objects` and `activity`.

use tauri::State;

use crate::activity::{self, ActivityRow, LockRow};
use crate::commands::on_session;
use crate::error::{AppError, AppResult};
use crate::logging::Op;
use crate::pg::objects::{
    self, AvailableExtension, ExtensionAction, ExtensionInfo, MaintenanceAction, RoleInfo,
};
use crate::pg::PgSession;
use crate::state::AppState;

/// The error a change gets on a read-only connection.
fn refuse_when_read_only(s: &PgSession) -> AppResult<()> {
    if s.target.settings.read_only {
        return Err(AppError::InvalidInput(
            "This connection is read-only. Edit the connection to allow changes.".to_string(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn list_extensions(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Vec<ExtensionInfo>> {
    let op = Op::new("listExtensions", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        objects::list_extensions(&client).await
    })
    .await
}

#[tauri::command]
pub async fn list_available_extensions(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Vec<AvailableExtension>> {
    let op = Op::new("listAvailableExtensions", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        objects::list_available_extensions(&client).await
    })
    .await
}

/// Installs, updates or drops one extension. The page asks the user first.
#[tauri::command]
pub async fn extension_action(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    name: String,
    action: ExtensionAction,
) -> AppResult<()> {
    let op = Op::new("extension", &database, Some(&name));
    on_session(&state, &session_id, op, async |s| {
        refuse_when_read_only(&s)?;
        let client = s.client(&database).await?;
        objects::run_extension_action(&client, &name, &action).await?;
        log::info!(
            "{} [{}] {}",
            Op::new("extension", &database, Some(&name)),
            s.name,
            objects::extension_sql(&name, &action)
        );
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn server_activity(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Vec<ActivityRow>> {
    let op = Op::new("activity", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        activity::list_activity(&client).await
    })
    .await
}

/// With `all`, every lock; otherwise those waiting or blocking.
#[tauri::command]
pub async fn server_locks(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    all: bool,
) -> AppResult<Vec<LockRow>> {
    let op = Op::new("locks", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        activity::list_locks(&client, all).await
    })
    .await
}

/// Cancels a backend's query, or with `terminate` ends its session. The
/// answer is whether the server signalled it; the page asks about
/// terminating first.
#[tauri::command]
pub async fn signal_backend(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    pid: i32,
    terminate: bool,
) -> AppResult<bool> {
    let op = Op::new(
        if terminate { "terminate" } else { "cancel" },
        &database,
        None,
    );
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        let signalled = activity::signal_backend(&client, pid, terminate).await?;
        log::info!(
            "{} [{}] backend {pid}: {}",
            Op::new(
                if terminate { "terminate" } else { "cancel" },
                &database,
                None
            ),
            s.name,
            if signalled {
                "signalled"
            } else {
                "not signalled"
            }
        );
        Ok(signalled)
    })
    .await
}

/// The server's roles; they belong to the cluster, so any database will do.
#[tauri::command]
pub async fn list_roles(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Vec<RoleInfo>> {
    let op = Op::new("listRoles", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        objects::list_roles(&client).await
    })
    .await
}

/// VACUUM (ANALYZE), ANALYZE, REINDEX or TRUNCATE on one table; resolves to
/// how long it took, in ms. The page asks first for TRUNCATE.
#[tauri::command]
pub async fn run_maintenance(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
    table: String,
    action: MaintenanceAction,
) -> AppResult<u64> {
    let target = format!("{schema}.{table}");
    let op = Op::new("maintenance", &database, Some(&target));
    on_session(&state, &session_id, op, async |s| {
        // The server refuses TRUNCATE in a read-only transaction anyway; say
        // why in the app's words.
        if action == MaintenanceAction::Truncate {
            refuse_when_read_only(&s)?;
        }
        let started = std::time::Instant::now();
        objects::run_maintenance(&s, &database, &schema, &table, action).await?;
        log::info!(
            "{} [{}] {}",
            Op::new("maintenance", &database, Some(&target)),
            s.name,
            objects::maintenance_sql(&schema, &table, action)
        );
        Ok(started.elapsed().as_millis() as u64)
    })
    .await
}
