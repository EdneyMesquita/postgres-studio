//! Commands for the objects around tables: extensions, the server's
//! activity, roles and maintenance. The reads and statements themselves
//! live in `pg::objects` and `activity`.

use tauri::State;

use crate::commands::on_session;
use crate::error::{AppError, AppResult};
use crate::logging::Op;
use crate::pg::objects::{self, AvailableExtension, ExtensionAction, ExtensionInfo};
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
