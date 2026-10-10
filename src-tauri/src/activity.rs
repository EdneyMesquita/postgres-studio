//! The server's activity: what each backend is doing, who waits on whom,
//! and stopping a query or a session.
//!
//! Reads are single `json_agg` statements like the catalog's. They run on
//! whichever database the tab is on: `pg_stat_activity` and `pg_locks` span
//! the whole server.

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::pg::catalog::json_query;
use crate::pg::PgClient;

/// One backend, as `pg_stat_activity` shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub pid: i64,
    /// Null for processes that belong to no role.
    pub user: Option<String>,
    pub database: Option<String>,
    pub application: Option<String>,
    pub client_addr: Option<String>,
    /// `active`, `idle`, `idle in transaction`...; null for background processes.
    pub state: Option<String>,
    pub wait_event_type: Option<String>,
    pub wait_event: Option<String>,
    /// `client backend`, `autovacuum worker`, `walwriter`...
    pub backend_type: Option<String>,
    /// When the open transaction began.
    pub xact_start: Option<String>,
    /// How long the transaction has been open, in ms.
    pub xact_age_ms: Option<i64>,
    /// When the current (or last) query began.
    pub query_start: Option<String>,
    /// How long ago the query began, in ms: its duration while `active`.
    pub query_age_ms: Option<i64>,
    /// The backends this one waits on.
    pub blocked_by: Vec<i64>,
    pub query: Option<String>,
    /// One of this app's own sessions: the same `application_name` as the
    /// session that asked.
    pub own: bool,
}

/// Every backend but the one that asks, so the monitor does not list its
/// own poll.
pub async fn list_activity(client: &PgClient) -> AppResult<Vec<ActivityRow>> {
    let sql = "SELECT coalesce(json_agg(x ORDER BY x.pid), '[]') FROM (
        SELECT a.pid::int8 AS pid, a.usename AS \"user\", a.datname AS database,
               a.application_name AS application, host(a.client_addr) AS \"clientAddr\",
               a.state, a.wait_event_type AS \"waitEventType\", a.wait_event AS \"waitEvent\",
               a.backend_type AS \"backendType\",
               a.xact_start AS \"xactStart\",
               (extract(epoch FROM now() - a.xact_start) * 1000)::int8 AS \"xactAgeMs\",
               a.query_start AS \"queryStart\",
               (extract(epoch FROM now() - a.query_start) * 1000)::int8 AS \"queryAgeMs\",
               to_json(pg_blocking_pids(a.pid)) AS \"blockedBy\",
               a.query,
               a.application_name = current_setting('application_name') AS own
        FROM pg_stat_activity a
        WHERE a.pid <> pg_backend_pid()
    ) x";
    Ok(json_query(client, sql).await?.unwrap_or_default())
}

/// One lock held or awaited, with the backend it belongs to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockRow {
    pub pid: i64,
    pub user: Option<String>,
    pub database: Option<String>,
    pub application: Option<String>,
    pub locktype: String,
    pub mode: String,
    pub granted: bool,
    /// The relation, schema-qualified when it is in the current database.
    pub relation: Option<String>,
    /// Who holds what this lock waits for; empty for a granted lock.
    pub blocked_by: Vec<i64>,
    /// Some other backend waits on this one.
    pub blocking: bool,
    pub state: Option<String>,
    pub query: Option<String>,
    pub query_age_ms: Option<i64>,
    pub own: bool,
}

/// The locks that matter: those waiting, and those held by a backend
/// somebody waits on. With `all`, every lock (capped).
pub async fn list_locks(client: &PgClient, all: bool) -> AppResult<Vec<LockRow>> {
    let sql = format!(
        "WITH blockers AS (
            SELECT DISTINCT unnest(pg_blocking_pids(pid)) AS pid FROM pg_stat_activity
         )
         SELECT coalesce(json_agg(x), '[]') FROM (
            SELECT l.pid::int8 AS pid, a.usename AS \"user\", a.datname AS database,
                   a.application_name AS application, l.locktype, l.mode, l.granted,
                   CASE WHEN l.relation IS NULL THEN NULL
                        WHEN l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                            THEN l.relation::regclass::text
                        ELSE 'oid ' || l.relation END AS relation,
                   to_json(CASE WHEN l.granted THEN ARRAY[]::int4[] ELSE pg_blocking_pids(l.pid) END) AS \"blockedBy\",
                   l.pid IN (SELECT pid FROM blockers) AS blocking,
                   a.state, left(a.query, 500) AS query,
                   (extract(epoch FROM now() - a.query_start) * 1000)::int8 AS \"queryAgeMs\",
                   coalesce(a.application_name = current_setting('application_name'), false) AS own
            FROM pg_locks l
            LEFT JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.pid IS NOT NULL AND l.pid <> pg_backend_pid()
              AND ({scope})
            ORDER BY l.granted, l.pid, l.locktype, l.mode
            LIMIT 2000
         ) x",
        scope = if all {
            "true"
        } else {
            "NOT l.granted OR l.pid IN (SELECT pid FROM blockers)"
        },
    );
    Ok(json_query(client, &sql).await?.unwrap_or_default())
}

/// `pg_cancel_backend` or `pg_terminate_backend`: whether the server
/// signalled the backend (false when it is gone, or the role may not).
pub async fn signal_backend(client: &PgClient, pid: i32, terminate: bool) -> AppResult<bool> {
    let function = if terminate {
        "pg_terminate_backend"
    } else {
        "pg_cancel_backend"
    };
    let sql = format!("SELECT to_json({function}({pid}))");
    Ok(json_query(client, &sql).await?.unwrap_or(false))
}

#[cfg(test)]
mod live_tests {
    //! Against the dev server. Run with:
    //!   POSTGRES_STUDIO_TEST_URI=postgres://postgres:postgres@localhost:5433/shop \
    //!     cargo test --lib -- --ignored activity
    use super::*;
    use crate::pg::test_support::live_session as session;

    #[tokio::test]
    #[ignore]
    async fn live_activity_locks_and_signals() {
        let s = session().await;
        let c = s.client("shop").await.unwrap();
        c.client
            .batch_execute("DROP TABLE IF EXISTS agent_objects_lock")
            .await
            .unwrap();
        c.client
            .batch_execute("CREATE TABLE agent_objects_lock (id int)")
            .await
            .unwrap();

        // a holder with an open transaction, and a waiter behind it
        let holder = s.pinned("holder", "shop").await.unwrap();
        holder
            .client
            .batch_execute("SET application_name = 'agent_objects_holder'; BEGIN; LOCK TABLE agent_objects_lock IN ACCESS EXCLUSIVE MODE")
            .await
            .unwrap();
        let holder_pid: i64 = pid_of(&holder).await;
        let waiter = s.pinned("waiter", "shop").await.unwrap();
        waiter
            .client
            .batch_execute("SET application_name = 'agent_objects_waiter'")
            .await
            .unwrap();
        let waiter_pid: i64 = pid_of(&waiter).await;
        let blocked = tokio::spawn(async move {
            waiter
                .client
                .batch_execute("SELECT count(*) FROM agent_objects_lock")
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let me = pid_of(&c).await;
        let rows = list_activity(&c).await.unwrap();
        assert!(rows.iter().all(|r| r.pid != me), "own poll excluded");
        let h = rows.iter().find(|r| r.pid == holder_pid).unwrap();
        assert_eq!(h.state.as_deref(), Some("idle in transaction"));
        assert!(h.xact_age_ms.unwrap() >= 0 && h.xact_start.is_some());
        assert!(!h.own, "a different application_name");
        let w = rows.iter().find(|r| r.pid == waiter_pid).unwrap();
        assert_eq!(w.blocked_by, [holder_pid]);
        assert_eq!(w.wait_event_type.as_deref(), Some("Lock"));
        assert_eq!(w.state.as_deref(), Some("active"));
        assert!(w.query.as_deref().unwrap().contains("agent_objects_lock"));
        assert!(
            rows.iter()
                .any(|r| r.backend_type.as_deref() == Some("checkpointer")),
            "background processes are listed"
        );

        let locks = list_locks(&c, false).await.unwrap();
        let waiting = locks
            .iter()
            .find(|l| l.pid == waiter_pid && !l.granted)
            .unwrap();
        assert_eq!(waiting.blocked_by, [holder_pid]);
        assert_eq!(waiting.locktype, "relation");
        assert_eq!(waiting.relation.as_deref(), Some("agent_objects_lock"));
        let holding = locks
            .iter()
            .find(|l| l.pid == holder_pid && l.relation.as_deref() == Some("agent_objects_lock"))
            .unwrap();
        assert!(holding.granted && holding.blocking && holding.blocked_by.is_empty());
        assert!(list_locks(&c, true).await.unwrap().len() >= locks.len());

        // cancel the waiter's query: it fails with 57014, the holder stays
        assert!(signal_backend(&c, waiter_pid as i32, false).await.unwrap());
        let err = blocked.await.unwrap().unwrap_err();
        assert!(matches!(
            crate::error::AppError::from(err),
            crate::error::AppError::Cancelled
        ));
        // terminate the holder: its transaction goes, the table frees
        assert!(signal_backend(&c, holder_pid as i32, true).await.unwrap());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!list_activity(&c)
            .await
            .unwrap()
            .iter()
            .any(|r| r.pid == holder_pid));
        // a pid that is gone signals nothing
        assert!(!signal_backend(&c, holder_pid as i32, true).await.unwrap());

        c.client
            .batch_execute("DROP TABLE IF EXISTS agent_objects_lock")
            .await
            .unwrap();
        s.shutdown().await;
    }

    async fn pid_of(c: &PgClient) -> i64 {
        json_query(c, "SELECT to_json(pg_backend_pid()::int8)")
            .await
            .unwrap()
            .unwrap()
    }
}
