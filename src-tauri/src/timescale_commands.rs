//! Commands for TimescaleDB. Reads work on any edition and version the
//! probe finds; the actions need the 2.18+ API, refuse a read-only
//! connection and, for the TSL features, the Apache edition. The reads and
//! statements themselves live in `pg::timescale` and `pg::timescale_actions`.

use tauri::State;

use crate::commands::on_session;
use crate::error::{AppError, AppResult};
use crate::logging::Op;
use crate::pg::timescale::{
    self, CaggDetail, DropChunksPreview, HypertableDetail, JobInfo, TimescaleInfo,
};
use crate::pg::timescale_actions::{self, TimescaleAction};
use crate::pg::{PgClient, PgSession};
use crate::state::AppState;

async fn installed(client: &PgClient) -> AppResult<TimescaleInfo> {
    timescale::probe(client).await?.ok_or_else(|| {
        AppError::InvalidInput("TimescaleDB isn't installed in this database.".to_string())
    })
}

/// Why an action can't run here, in the app's words rather than the
/// server's.
fn refuse(s: &PgSession, ts: &TimescaleInfo, action: &TimescaleAction) -> AppResult<()> {
    if s.target.settings.read_only {
        return Err(AppError::InvalidInput(
            "This connection is read-only. Edit the connection to allow changes.".to_string(),
        ));
    }
    if !ts.columnstore_api {
        return Err(AppError::InvalidInput(format!(
            "TimescaleDB {} is older than 2.18; the app only reads it. Run the change from a console.",
            ts.version
        )));
    }
    // drop_chunks and the job controls are in the Apache edition too
    let needs_community = matches!(
        action,
        TimescaleAction::RefreshCagg { .. }
            | TimescaleAction::ToColumnstore { .. }
            | TimescaleAction::ToRowstore { .. }
            | TimescaleAction::SetRealtime { .. }
    );
    if needs_community && !ts.community {
        return Err(AppError::InvalidInput(
            "This server runs the Apache edition of TimescaleDB, which leaves out continuous \
             aggregates and the columnstore."
                .to_string(),
        ));
    }
    Ok(())
}

/// The extension's version and edition, or null without it.
#[tauri::command]
pub async fn timescale_info(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Option<TimescaleInfo>> {
    let op = Op::new("timescaleInfo", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        timescale::probe(&client).await
    })
    .await
}

#[tauri::command]
pub async fn timescale_hypertable(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
    name: String,
) -> AppResult<HypertableDetail> {
    let target = format!("{schema}.{name}");
    let op = Op::new("timescaleHypertable", &database, Some(&target));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        let ts = installed(&client).await?;
        timescale::hypertable_detail(&client, &schema, &name, &ts).await
    })
    .await
}

#[tauri::command]
pub async fn timescale_cagg(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
    name: String,
) -> AppResult<CaggDetail> {
    let target = format!("{schema}.{name}");
    let op = Op::new("timescaleCagg", &database, Some(&target));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        let ts = installed(&client).await?;
        timescale::cagg_detail(&client, &schema, &name, &ts).await
    })
    .await
}

#[tauri::command]
pub async fn timescale_jobs(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
) -> AppResult<Vec<JobInfo>> {
    let op = Op::new("timescaleJobs", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        installed(&client).await?;
        timescale::jobs(&client).await
    })
    .await
}

/// What `drop_chunks` would remove; the page shows it before asking.
#[tauri::command]
pub async fn timescale_drop_chunks_preview(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    schema: String,
    name: String,
    older_than: String,
) -> AppResult<DropChunksPreview> {
    let target = format!("{schema}.{name}");
    let op = Op::new("timescaleDropPreview", &database, Some(&target));
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        installed(&client).await?;
        timescale_actions::drop_chunks_preview(&client, &schema, &name, &older_than).await
    })
    .await
}

/// The statement an action would run, for the confirmation to show.
#[tauri::command]
pub async fn timescale_action_sql(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    action: TimescaleAction,
) -> AppResult<String> {
    let op = Op::new("timescaleActionSql", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        let ts = installed(&client).await?;
        Ok(timescale_actions::action_sql(&action, &ts))
    })
    .await
}

/// Runs one action; resolves to how long it took, in ms. The page asks first.
#[tauri::command]
pub async fn timescale_action(
    state: State<'_, AppState>,
    session_id: String,
    database: String,
    action: TimescaleAction,
) -> AppResult<u64> {
    let op = Op::new("timescaleAction", &database, None);
    on_session(&state, &session_id, op, async |s| {
        let client = s.client(&database).await?;
        let ts = installed(&client).await?;
        refuse(&s, &ts, &action)?;
        let started = std::time::Instant::now();
        timescale_actions::run_action(&s, &database, &action, &ts).await?;
        log::info!(
            "{} [{}] {}",
            Op::new("timescaleAction", &database, None),
            s.name,
            timescale_actions::action_sql(&action, &ts)
        );
        Ok(started.elapsed().as_millis() as u64)
    })
    .await
}
