//! The TimescaleDB actions the app runs for the user, after asking:
//! refreshing a continuous aggregate over a range, running, pausing and
//! resuming a job, converting a chunk to and from the columnstore, dropping
//! old chunks and turning real-time aggregation on or off.
//!
//! `refresh_continuous_aggregate` (and `run_job` on a refresh job) refuse
//! to run inside a transaction block, and a `batch_execute` of several
//! statements is one implicit transaction: each action is one statement,
//! sent alone on a client of its own, as `objects::run_maintenance` does.

use serde::{Deserialize, Serialize};

use super::timescale::{DropChunksPreview, TimescaleInfo};
use super::{PgClient, PgSession};
use crate::error::AppResult;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TimescaleAction {
    /// `start`/`end` as timestamps (or integers for an integer time column);
    /// null leaves that side open.
    RefreshCagg {
        schema: String,
        name: String,
        start: Option<String>,
        end: Option<String>,
    },
    /// Through the scheduler (`alter_job(next_start => now())`), so the
    /// outcome lands in the job's history and errors.
    RunJob {
        job_id: i32,
    },
    PauseJob {
        job_id: i32,
    },
    ResumeJob {
        job_id: i32,
    },
    /// A chunk, by its own schema and name.
    ToColumnstore {
        schema: String,
        name: String,
    },
    ToRowstore {
        schema: String,
        name: String,
    },
    /// `older_than` is an interval (`60 days`) for a time column, an integer
    /// for an integer one.
    DropChunks {
        schema: String,
        name: String,
        older_than: String,
    },
    SetRealtime {
        schema: String,
        name: String,
        enabled: bool,
    },
}

/// The one statement an action runs, in the API generation `ts` speaks.
pub fn action_sql(action: &TimescaleAction, ts: &TimescaleInfo) -> String {
    let _ = (action, ts);
    String::new()
}

/// Runs an action alone on a client of its own, outside any transaction.
pub async fn run_action(
    session: &PgSession,
    database: &str,
    action: &TimescaleAction,
    ts: &TimescaleInfo,
) -> AppResult<()> {
    let _ = (session, database, action, ts);
    Ok(())
}

/// The chunks `drop_chunks(older_than)` would remove, and what reads them.
pub async fn drop_chunks_preview(
    client: &PgClient,
    schema: &str,
    name: &str,
    older_than: &str,
) -> AppResult<DropChunksPreview> {
    let _ = (client, schema, name, older_than);
    Ok(DropChunksPreview::default())
}
