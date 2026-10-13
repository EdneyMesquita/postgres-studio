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

use super::catalog::json_query;
use super::timescale::{DropChunksPreview, TimescaleInfo};
use super::{literal, qualified, PgClient, PgSession};
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

/// The one statement an action runs. Only the 2.18+ API exists here: the
/// commands refuse older servers before they get this far.
pub fn action_sql(action: &TimescaleAction, _ts: &TimescaleInfo) -> String {
    match action {
        TimescaleAction::RefreshCagg {
            schema,
            name,
            start,
            end,
        } => format!(
            "CALL refresh_continuous_aggregate({}, {}, {})",
            literal(&qualified(schema, name)),
            bound(start.as_deref()),
            bound(end.as_deref()),
        ),
        TimescaleAction::RunJob { job_id } => {
            format!("SELECT alter_job({job_id}, next_start => now())")
        }
        TimescaleAction::PauseJob { job_id } => {
            format!("SELECT alter_job({job_id}, scheduled => false)")
        }
        TimescaleAction::ResumeJob { job_id } => {
            format!("SELECT alter_job({job_id}, scheduled => true)")
        }
        TimescaleAction::ToColumnstore { schema, name } => format!(
            "CALL convert_to_columnstore({}, if_not_columnstore => true)",
            literal(&qualified(schema, name))
        ),
        TimescaleAction::ToRowstore { schema, name } => format!(
            "CALL convert_to_rowstore({}, if_columnstore => true)",
            literal(&qualified(schema, name))
        ),
        TimescaleAction::DropChunks {
            schema,
            name,
            older_than,
        } => format!(
            "SELECT drop_chunks({}, older_than => {})",
            literal(&qualified(schema, name)),
            older_than_sql(older_than)
        ),
        TimescaleAction::SetRealtime {
            schema,
            name,
            enabled,
        } => format!(
            "ALTER MATERIALIZED VIEW {} SET (timescaledb.materialized_only = {})",
            qualified(schema, name),
            !enabled
        ),
    }
}

/// A refresh bound: a quoted value the server reads as the cagg's time type,
/// or NULL to leave that side open.
fn bound(value: Option<&str>) -> String {
    value.map_or_else(|| "NULL".to_string(), literal)
}

/// `older_than` for `drop_chunks` and `show_chunks`: a bare integer for an
/// integer time column, an interval otherwise. An integer is written as the
/// parsed number, so nothing of the input reaches the statement but digits.
fn older_than_sql(older_than: &str) -> String {
    match older_than.trim().parse::<i64>() {
        Ok(n) => n.to_string(),
        Err(_) => format!("INTERVAL {}", literal(older_than)),
    }
}

/// Runs an action alone on a client of its own, outside any transaction.
pub async fn run_action(
    session: &PgSession,
    database: &str,
    action: &TimescaleAction,
    ts: &TimescaleInfo,
) -> AppResult<()> {
    let key = format!("timescale:{}", uuid::Uuid::new_v4());
    let client = session.pinned(&key, database).await?;
    let result = client.client.batch_execute(&action_sql(action, ts)).await;
    session.release(&key).await;
    Ok(result?)
}

/// The chunks `drop_chunks(older_than)` would remove, and what reads them.
pub async fn drop_chunks_preview(
    client: &PgClient,
    schema: &str,
    name: &str,
    older_than: &str,
) -> AppResult<DropChunksPreview> {
    let ht = literal(&qualified(schema, name));
    let x = older_than_sql(older_than);
    let sql = format!(
        "WITH shown AS (
             SELECT c AS chunk FROM show_chunks({ht}, older_than => {x}) AS c
         ), chunks AS (
             SELECT ch.chunk_schema, ch.chunk_name, ch.is_compressed,
                    ch.range_start, ch.range_start_integer,
                    ch.range_end, ch.range_end_integer
             FROM shown s
             JOIN timescaledb_information.chunks ch
               ON format('%I.%I', ch.chunk_schema, ch.chunk_name)::regclass = s.chunk
         ), rows AS (
             SELECT c.*, d.total_bytes, cs.before_compression_total_bytes,
                    cs.after_compression_total_bytes
             FROM chunks c
             LEFT JOIN chunks_detailed_size({ht}) d
               ON d.chunk_schema = c.chunk_schema AND d.chunk_name = c.chunk_name
             LEFT JOIN chunk_columnstore_stats({ht}) cs
               ON cs.chunk_schema = c.chunk_schema AND cs.chunk_name = c.chunk_name
         )
         SELECT json_build_object(
             'chunks', coalesce((
                 SELECT json_agg(json_build_object(
                     'schema', chunk_schema,
                     'name', chunk_name,
                     'rangeStart', coalesce(range_start::text, range_start_integer::text),
                     'rangeEnd', coalesce(range_end::text, range_end_integer::text),
                     'isCompressed', is_compressed,
                     'totalBytes', total_bytes,
                     'beforeBytes', before_compression_total_bytes,
                     'afterBytes', after_compression_total_bytes
                 ) ORDER BY range_start DESC NULLS LAST, range_start_integer DESC NULLS LAST)
                 FROM rows
             ), '[]'::json),
             'totalBytes', (SELECT coalesce(sum(total_bytes), 0)::bigint FROM rows),
             'dependentCaggs', coalesce((
                 SELECT json_agg(json_build_object('schema', view_schema, 'name', view_name)
                                 ORDER BY view_schema, view_name)
                 FROM timescaledb_information.continuous_aggregates
                 WHERE hypertable_schema = {hs} AND hypertable_name = {hn}
             ), '[]'::json)
         )",
        hs = literal(schema),
        hn = literal(name),
    );
    Ok(json_query(client, &sql).await?.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> TimescaleInfo {
        TimescaleInfo {
            version: "2.30.2".into(),
            major: 2,
            minor: 30,
            license: "timescale".into(),
            schema: "public".into(),
            columnstore_api: true,
            community: true,
        }
    }

    fn sql(action: TimescaleAction) -> String {
        action_sql(&action, &info())
    }

    fn refresh(start: Option<&str>, end: Option<&str>) -> TimescaleAction {
        TimescaleAction::RefreshCagg {
            schema: "public".into(),
            name: "metrics_hourly".into(),
            start: start.map(str::to_string),
            end: end.map(str::to_string),
        }
    }

    #[test]
    fn every_action_is_one_statement() {
        assert_eq!(
            sql(refresh(None, None)),
            "CALL refresh_continuous_aggregate($q$\"public\".\"metrics_hourly\"$q$, NULL, NULL)"
        );
        assert_eq!(
            sql(refresh(Some("2026-10-01"), Some("2026-10-02 12:00:00+00"))),
            "CALL refresh_continuous_aggregate($q$\"public\".\"metrics_hourly\"$q$, \
             $q$2026-10-01$q$, $q$2026-10-02 12:00:00+00$q$)"
        );
        assert_eq!(
            sql(refresh(Some("100"), None)),
            "CALL refresh_continuous_aggregate($q$\"public\".\"metrics_hourly\"$q$, $q$100$q$, NULL)"
        );
        assert_eq!(
            sql(TimescaleAction::RunJob { job_id: 1003 }),
            "SELECT alter_job(1003, next_start => now())"
        );
        assert_eq!(
            sql(TimescaleAction::PauseJob { job_id: 1003 }),
            "SELECT alter_job(1003, scheduled => false)"
        );
        assert_eq!(
            sql(TimescaleAction::ResumeJob { job_id: 1003 }),
            "SELECT alter_job(1003, scheduled => true)"
        );
        let chunk = || TimescaleAction::ToColumnstore {
            schema: "_timescaledb_internal".into(),
            name: "_hyper_1_2_chunk".into(),
        };
        assert_eq!(
            sql(chunk()),
            "CALL convert_to_columnstore($q$\"_timescaledb_internal\".\"_hyper_1_2_chunk\"$q$, if_not_columnstore => true)"
        );
        assert_eq!(
            sql(TimescaleAction::ToRowstore {
                schema: "_timescaledb_internal".into(),
                name: "_hyper_1_2_chunk".into(),
            }),
            "CALL convert_to_rowstore($q$\"_timescaledb_internal\".\"_hyper_1_2_chunk\"$q$, if_columnstore => true)"
        );
        assert_eq!(
            sql(TimescaleAction::DropChunks {
                schema: "public".into(),
                name: "events".into(),
                older_than: "60 days".into(),
            }),
            "SELECT drop_chunks($q$\"public\".\"events\"$q$, older_than => INTERVAL $q$60 days$q$)"
        );
        assert_eq!(
            sql(TimescaleAction::SetRealtime {
                schema: "public".into(),
                name: "metrics_daily".into(),
                enabled: true,
            }),
            "ALTER MATERIALIZED VIEW \"public\".\"metrics_daily\" SET (timescaledb.materialized_only = false)"
        );
        assert_eq!(
            sql(TimescaleAction::SetRealtime {
                schema: "public".into(),
                name: "metrics_daily".into(),
                enabled: false,
            }),
            "ALTER MATERIALIZED VIEW \"public\".\"metrics_daily\" SET (timescaledb.materialized_only = true)"
        );
    }

    #[test]
    fn names_are_quoted_and_escaped() {
        let s = TimescaleAction::RefreshCagg {
            schema: "My \"Schema\"".into(),
            name: "Sensor Readings".into(),
            start: None,
            end: None,
        };
        assert_eq!(
            sql(s),
            "CALL refresh_continuous_aggregate($q$\"My \"\"Schema\"\"\".\"Sensor Readings\"$q$, NULL, NULL)"
        );
        assert_eq!(
            sql(TimescaleAction::SetRealtime {
                schema: "My \"Schema\"".into(),
                name: "Sensor Readings".into(),
                enabled: true,
            }),
            "ALTER MATERIALIZED VIEW \"My \"\"Schema\"\"\".\"Sensor Readings\" SET (timescaledb.materialized_only = false)"
        );
    }

    #[test]
    fn older_than_is_an_integer_or_an_interval() {
        let drop = |older_than: &str| {
            sql(TimescaleAction::DropChunks {
                schema: "public".into(),
                name: "events".into(),
                older_than: older_than.into(),
            })
        };
        assert!(drop("1500").ends_with("older_than => 1500)"));
        assert!(drop("-5").ends_with("older_than => -5)"));
        assert!(drop(" 42 ").ends_with("older_than => 42)"));
        assert!(drop("60 days").ends_with("older_than => INTERVAL $q$60 days$q$)"));
        assert!(drop("1 day").ends_with("INTERVAL $q$1 day$q$)"));
    }

    #[test]
    fn hostile_older_than_stays_inside_its_literal() {
        let hostile = "1 day'); DROP TABLE x; --";
        let s = sql(TimescaleAction::DropChunks {
            schema: "public".into(),
            name: "events".into(),
            older_than: hostile.into(),
        });
        assert_eq!(
            s,
            "SELECT drop_chunks($q$\"public\".\"events\"$q$, older_than => INTERVAL $q$1 day'); DROP TABLE x; --$q$)"
        );
        // a value that holds the closing tag gets a longer tag
        let s = sql(TimescaleAction::DropChunks {
            schema: "public".into(),
            name: "events".into(),
            older_than: "1 day$q$); DROP TABLE x; --".into(),
        });
        assert!(
            s.contains("INTERVAL $q1$1 day$q$); DROP TABLE x; --$q1$)"),
            "{s}"
        );
    }

    #[test]
    fn action_json_matches_the_typescript_shape() {
        let cases = [
            (
                TimescaleAction::RefreshCagg {
                    schema: "public".into(),
                    name: "metrics_hourly".into(),
                    start: None,
                    end: Some("2026-10-01".into()),
                },
                r#"{"kind":"refreshCagg","schema":"public","name":"metrics_hourly","start":null,"end":"2026-10-01"}"#,
            ),
            (
                TimescaleAction::RunJob { job_id: 1003 },
                r#"{"kind":"runJob","jobId":1003}"#,
            ),
            (
                TimescaleAction::PauseJob { job_id: 1003 },
                r#"{"kind":"pauseJob","jobId":1003}"#,
            ),
            (
                TimescaleAction::ResumeJob { job_id: 1003 },
                r#"{"kind":"resumeJob","jobId":1003}"#,
            ),
            (
                TimescaleAction::ToColumnstore {
                    schema: "_timescaledb_internal".into(),
                    name: "_hyper_1_2_chunk".into(),
                },
                r#"{"kind":"toColumnstore","schema":"_timescaledb_internal","name":"_hyper_1_2_chunk"}"#,
            ),
            (
                TimescaleAction::ToRowstore {
                    schema: "_timescaledb_internal".into(),
                    name: "_hyper_1_2_chunk".into(),
                },
                r#"{"kind":"toRowstore","schema":"_timescaledb_internal","name":"_hyper_1_2_chunk"}"#,
            ),
            (
                TimescaleAction::DropChunks {
                    schema: "public".into(),
                    name: "events".into(),
                    older_than: "60 days".into(),
                },
                r#"{"kind":"dropChunks","schema":"public","name":"events","olderThan":"60 days"}"#,
            ),
            (
                TimescaleAction::SetRealtime {
                    schema: "public".into(),
                    name: "metrics_daily".into(),
                    enabled: true,
                },
                r#"{"kind":"setRealtime","schema":"public","name":"metrics_daily","enabled":true}"#,
            ),
        ];
        for (action, json) in cases {
            assert_eq!(serde_json::to_string(&action).unwrap(), json);
            let back: TimescaleAction = serde_json::from_str(json).unwrap();
            assert_eq!(back, action);
        }
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the TimescaleDB test server (docker `postgres-studio-timescale`).
    //! Each test returns early when its variable isn't set:
    //!   POSTGRES_STUDIO_TIMESCALE_URI=postgres://postgres:postgres@localhost:5436/tsdb \
    //!     cargo test --lib -- --ignored timescale_actions
    //! The seed's objects are changed only and put back: the test-made
    //! hypertable is dropped, and the seed's real-time, chunk and job states
    //! are restored.
    use super::*;
    use crate::models::{
        ConnectionAdvancedOptions, ConnectionProfile, ConnectionSource, SslMode, TlsOptions,
    };
    use crate::pg::{PgClient, PgSession};
    use crate::secrets::InMemoryStore;
    use std::sync::Arc;

    async fn session() -> Option<PgSession> {
        let uri = match std::env::var("POSTGRES_STUDIO_TIMESCALE_URI") {
            Ok(uri) => uri,
            Err(_) => {
                eprintln!("skipped: POSTGRES_STUDIO_TIMESCALE_URI is not set");
                return None;
            }
        };
        let profile = ConnectionProfile {
            id: "live".into(),
            name: "live".into(),
            color: None,
            source: ConnectionSource::Uri { uri },
            database: None,
            username: None,
            has_password: false,
            tls: TlsOptions {
                ssl_mode: SslMode::Disable,
                ..Default::default()
            },
            ssh_tunnel: None,
            advanced: ConnectionAdvancedOptions::default(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let known = Arc::new(crate::ssh_tunnel::KnownHosts::load(&std::env::temp_dir()).unwrap());
        Some(
            PgSession::connect(&profile, &InMemoryStore::new(), &known)
                .await
                .unwrap(),
        )
    }

    /// The server's 2.30.2 facts, filled in by hand: the probe belongs to
    /// `pg::timescale` and this test shouldn't depend on it.
    fn info() -> TimescaleInfo {
        TimescaleInfo {
            version: "2.30.2".into(),
            major: 2,
            minor: 30,
            license: "timescale".into(),
            schema: "public".into(),
            columnstore_api: true,
            community: true,
        }
    }

    async fn one<T: serde::de::DeserializeOwned>(c: &PgClient, sql: &str) -> T {
        json_query(c, sql).await.unwrap().unwrap()
    }

    #[tokio::test]
    #[ignore]
    async fn live_timescale_actions_refresh_outside_a_transaction() {
        let Some(s) = session().await else {
            return;
        };
        let ts = info();
        let c = s.client("tsdb").await.unwrap();
        let start: String = one(&c, "SELECT to_json((now() - interval '2 days')::text)").await;
        run_action(
            &s,
            "tsdb",
            &TimescaleAction::RefreshCagg {
                schema: "public".into(),
                name: "metrics_hourly".into(),
                start: Some(start.clone()),
                end: None,
            },
            &ts,
        )
        .await
        .unwrap_or_else(|e| panic!("refresh: {e}"));

        // The same CALL inside a transaction block is refused: the reason
        // run_action sends each action alone on its own client.
        let key = "cagg-in-tx";
        let tx = s.pinned(key, "tsdb").await.unwrap();
        tx.client.batch_execute("BEGIN").await.unwrap();
        let err = tx
            .client
            .batch_execute(&action_sql(
                &TimescaleAction::RefreshCagg {
                    schema: "public".into(),
                    name: "metrics_hourly".into(),
                    start: Some(start),
                    end: None,
                },
                &ts,
            ))
            .await
            .unwrap_err();
        let db = err.as_db_error().expect("the server refuses the CALL");
        assert!(
            db.message().contains("transaction block"),
            "{}",
            db.message()
        );
        tx.client.batch_execute("ROLLBACK").await.unwrap();
        s.release(key).await;
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_timescale_actions_realtime_toggle() {
        let Some(s) = session().await else {
            return;
        };
        let ts = info();
        let c = s.client("tsdb").await.unwrap();
        let state = "SELECT to_json(materialized_only) FROM timescaledb_information.continuous_aggregates WHERE view_name = 'metrics_hourly'";
        let before: bool = one(&c, state).await;
        let action = |enabled| TimescaleAction::SetRealtime {
            schema: "public".into(),
            name: "metrics_hourly".into(),
            enabled,
        };
        run_action(&s, "tsdb", &action(true), &ts).await.unwrap();
        assert!(!one::<bool>(&c, state).await, "real-time on");
        run_action(&s, "tsdb", &action(false), &ts).await.unwrap();
        assert!(one::<bool>(&c, state).await, "real-time off");
        // back to the seed's state
        if !before {
            run_action(&s, "tsdb", &action(true), &ts).await.unwrap();
        }
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_timescale_actions_chunk_columnstore_round_trip() {
        let Some(s) = session().await else {
            return;
        };
        let ts = info();
        let c = s.client("tsdb").await.unwrap();
        let chunk: serde_json::Value = one(
            &c,
            "SELECT json_build_object('schema', chunk_schema, 'name', chunk_name)
             FROM timescaledb_information.chunks
             WHERE hypertable_schema = 'public' AND hypertable_name = 'metrics' AND is_compressed
             ORDER BY range_start LIMIT 1",
        )
        .await;
        let schema = chunk["schema"].as_str().unwrap().to_string();
        let name = chunk["name"].as_str().unwrap().to_string();
        let compressed = format!(
            "SELECT to_json(is_compressed) FROM timescaledb_information.chunks
             WHERE chunk_schema = {} AND chunk_name = {}",
            literal(&schema),
            literal(&name)
        );
        run_action(
            &s,
            "tsdb",
            &TimescaleAction::ToRowstore {
                schema: schema.clone(),
                name: name.clone(),
            },
            &ts,
        )
        .await
        .unwrap();
        assert!(!one::<bool>(&c, &compressed).await, "to rowstore");
        run_action(
            &s,
            "tsdb",
            &TimescaleAction::ToColumnstore { schema, name },
            &ts,
        )
        .await
        .unwrap();
        assert!(one::<bool>(&c, &compressed).await, "back to columnstore");
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_timescale_actions_pause_and_resume_the_failing_job() {
        let Some(s) = session().await else {
            return;
        };
        let ts = info();
        let c = s.client("tsdb").await.unwrap();
        let job_id: i32 = one(
            &c,
            "SELECT to_json(job_id) FROM timescaledb_information.jobs WHERE proc_name = 'failing_job'",
        )
        .await;
        let scheduled = format!(
            "SELECT to_json(scheduled) FROM timescaledb_information.jobs WHERE job_id = {job_id}"
        );
        run_action(&s, "tsdb", &TimescaleAction::PauseJob { job_id }, &ts)
            .await
            .unwrap();
        assert!(!one::<bool>(&c, &scheduled).await, "paused");
        run_action(&s, "tsdb", &TimescaleAction::ResumeJob { job_id }, &ts)
            .await
            .unwrap();
        assert!(one::<bool>(&c, &scheduled).await, "resumed");
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_timescale_actions_drop_chunks_with_preview() {
        let Some(s) = session().await else {
            return;
        };
        let ts = info();
        let c = s.client("tsdb").await.unwrap();
        c.client
            .batch_execute(
                "DROP TABLE IF EXISTS agent_ts_drop;
                 CREATE TABLE agent_ts_drop (time timestamptz NOT NULL, v float8);
                 SELECT create_hypertable('agent_ts_drop', by_range('time', INTERVAL '1 day'));
                 INSERT INTO agent_ts_drop
                 SELECT t, random() FROM generate_series(now() - INTERVAL '10 days', now(), INTERVAL '1 hour') t;",
            )
            .await
            .unwrap();
        let total: i64 = one(
            &c,
            "SELECT to_json(count(*)) FROM timescaledb_information.chunks WHERE hypertable_name = 'agent_ts_drop'",
        )
        .await;
        let expected: i64 = one(
            &c,
            "SELECT to_json(count(*)) FROM show_chunks('agent_ts_drop', older_than => INTERVAL '5 days')",
        )
        .await;
        let preview = drop_chunks_preview(&c, "public", "agent_ts_drop", "5 days")
            .await
            .unwrap();
        assert!(expected >= 4, "{expected}");
        assert_eq!(preview.chunks.len() as i64, expected);
        assert!(preview.chunks.iter().all(|ch| ch.total_bytes.is_some()));
        assert!(preview.chunks.iter().all(|ch| !ch.is_compressed));
        assert!(preview.chunks.iter().all(|ch| ch.before_bytes.is_none()));
        assert!(preview.chunks.iter().all(|ch| ch.range_start.is_some()));
        let sum: i64 = preview.chunks.iter().filter_map(|ch| ch.total_bytes).sum();
        assert_eq!(preview.total_bytes, sum);
        assert!(preview.total_bytes > 0);
        assert!(preview.dependent_caggs.is_empty());

        run_action(
            &s,
            "tsdb",
            &TimescaleAction::DropChunks {
                schema: "public".into(),
                name: "agent_ts_drop".into(),
                older_than: "5 days".into(),
            },
            &ts,
        )
        .await
        .unwrap();
        let left: i64 = one(
            &c,
            "SELECT to_json(count(*)) FROM timescaledb_information.chunks WHERE hypertable_name = 'agent_ts_drop'",
        )
        .await;
        assert_eq!(left, total - expected);
        let after = drop_chunks_preview(&c, "public", "agent_ts_drop", "5 days")
            .await
            .unwrap();
        assert!(after.chunks.is_empty());
        assert_eq!(after.total_bytes, 0);
        c.client
            .batch_execute("DROP TABLE agent_ts_drop")
            .await
            .unwrap();
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_timescale_actions_preview_reads_compressed_and_quoted_names() {
        let Some(s) = session().await else {
            return;
        };
        let c = s.client("tsdb").await.unwrap();
        // compressed chunks: before and after bytes, and the cagg built on it
        let metrics = drop_chunks_preview(&c, "public", "metrics", "20 days")
            .await
            .unwrap();
        assert!(!metrics.chunks.is_empty());
        let packed = metrics
            .chunks
            .iter()
            .find(|ch| ch.is_compressed)
            .expect("a compressed chunk older than 20 days");
        assert!(packed.before_bytes.is_some(), "{packed:?}");
        assert!(packed.after_bytes.is_some(), "{packed:?}");
        assert!(metrics
            .dependent_caggs
            .iter()
            .any(|r| r.schema == "public" && r.name == "metrics_hourly"));
        // quoted schema and hypertable names, through every read the preview makes
        let sensor = drop_chunks_preview(&c, "Telemetry", "Sensor Readings", "2 days")
            .await
            .unwrap();
        assert!(!sensor.chunks.is_empty());
        assert!(sensor.chunks.iter().all(|ch| ch.total_bytes.is_some()));
        assert!(sensor.total_bytes > 0);
        assert!(sensor.dependent_caggs.is_empty());
        s.shutdown().await;
    }
}
