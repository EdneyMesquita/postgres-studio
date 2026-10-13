//! TimescaleDB: hypertables, their chunks, continuous aggregates and the
//! background jobs behind the policies.
//!
//! Like AGE and pgvector in `graph`, nothing is assumed: the extension is
//! probed first, because a statement naming one of its views fails at parse
//! time on a database without it. Everything shown comes from the public
//! `timescaledb_information` views and the documented functions: nothing
//! reads `_timescaledb_catalog` or calls `_timescaledb_functions`, whose
//! shape changes between releases. What only those carry (a continuous
//! aggregate's exact watermark and bucket width) is derived instead: the
//! newest materialized bucket, and the `time_bucket` width in the
//! definition, each read on its own so a failure costs one field.

use serde::{Deserialize, Serialize};

use super::PgClient;
use crate::error::AppResult;

/// The installed extension: which API generation and which edition.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimescaleInfo {
    /// `extversion`, e.g. `2.30.2`.
    pub version: String,
    pub major: u32,
    pub minor: u32,
    /// `timescaledb.license`: `timescale` (Community, every feature) or
    /// `apache` (no continuous aggregates, policies, columnstore or jobs).
    pub license: String,
    /// The schema the extension's functions live in, e.g. `public`.
    pub schema: String,
    /// 2.18 or later: the columnstore API (`CALL convert_to_columnstore`
    /// and friends). The app's actions need it; older servers are read only.
    pub columnstore_api: bool,
    /// The Community edition, so the TSL features work.
    pub community: bool,
}

/// One dimension of a hypertable: the time column, or a hash partitioning.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dimension {
    pub number: i32,
    pub column: String,
    pub column_type: String,
    /// `Time` or `Space`, as `timescaledb_information.dimensions` says.
    pub kind: String,
    /// The chunk interval of a time-typed column, as the server prints it.
    pub time_interval: Option<String>,
    /// The chunk interval of an integer time column.
    pub integer_interval: Option<i64>,
    /// Hash partitions of a space dimension.
    pub num_partitions: Option<i32>,
}

/// What `describe_table` adds for a hypertable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HypertableSummary {
    pub dimensions: Vec<Dimension>,
    pub num_chunks: i64,
    pub compressed_chunks: i64,
    /// Columnstore (compression) is enabled on the hypertable.
    pub columnstore: bool,
    /// `hypertable_size`: every chunk, its indexes and TOAST.
    pub total_bytes: Option<i64>,
    /// `approximate_row_count`: from the chunks' statistics.
    pub approx_rows: Option<i64>,
}

/// What `describe_table` adds for a continuous aggregate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaggSummary {
    /// The hypertable it reads, or for a hierarchical one, the parent view.
    pub source_schema: String,
    pub source_name: String,
    /// `hypertable` or `cagg`.
    pub source_kind: String,
    pub materialization_schema: String,
    pub materialization_name: String,
    /// The user's query, not the view over the materialization table.
    pub view_definition: String,
    /// Real-time aggregation off: only materialized rows are returned.
    pub materialized_only: bool,
    pub columnstore: bool,
    /// The first `time_bucket` width in the definition (`1 hour`), when
    /// there is one to read.
    pub bucket_width: Option<String>,
    pub total_bytes: Option<i64>,
    pub approx_rows: Option<i64>,
}

/// What `describe_table` adds for a chunk of a hypertable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkParent {
    pub hypertable_schema: String,
    pub hypertable_name: String,
    pub is_compressed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkInfo {
    pub schema: String,
    pub name: String,
    /// Text as the server prints it: a timestamp, or an integer for
    /// integer time columns.
    pub range_start: Option<String>,
    pub range_end: Option<String>,
    pub is_compressed: bool,
    /// Now, on disk (`chunks_detailed_size`).
    pub total_bytes: Option<i64>,
    /// Columnstore stats: before and after conversion; null for a rowstore chunk.
    pub before_bytes: Option<i64>,
    pub after_bytes: Option<i64>,
}

/// One background job: a policy or a user-defined action.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub job_id: i32,
    pub application_name: String,
    pub proc_schema: String,
    pub proc_name: String,
    /// `refresh`, `columnstore`, `retention`, `reorder`, `custom` or `internal`.
    pub kind: String,
    /// The hypertable, or for a refresh policy the continuous aggregate.
    pub target_schema: Option<String>,
    pub target_name: Option<String>,
    pub schedule_interval: Option<String>,
    pub scheduled: bool,
    pub config: Option<serde_json::Value>,
    pub owner: Option<String>,
    /// `Success` or `Failed`, null before the first run.
    pub last_run_status: Option<String>,
    /// `Scheduled`, `Running` or `Paused`.
    pub job_status: Option<String>,
    pub last_run_started_at: Option<String>,
    pub last_successful_finish: Option<String>,
    pub last_run_duration: Option<String>,
    pub next_start: Option<String>,
    pub total_runs: Option<i64>,
    pub total_failures: Option<i64>,
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnstoreSettings {
    pub segmentby: Vec<String>,
    /// With direction, e.g. `time DESC`.
    pub orderby: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionTotals {
    pub total_chunks: i64,
    pub compressed_chunks: i64,
    pub before_bytes: Option<i64>,
    pub after_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationRef {
    pub schema: String,
    pub name: String,
}

/// The Structure page of a hypertable (or a cagg's materialization).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HypertableDetail {
    /// Newest first.
    pub chunks: Vec<ChunkInfo>,
    pub settings: Option<ColumnstoreSettings>,
    pub totals: Option<CompressionTotals>,
    pub policies: Vec<JobInfo>,
    /// The continuous aggregates built directly on it.
    pub caggs: Vec<RelationRef>,
}

/// The Structure page of a continuous aggregate.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaggDetail {
    /// `ok`, `never` (nothing materialized yet) or `unavailable` (no
    /// SELECT on the materialization, or it couldn't be read).
    pub watermark_state: String,
    /// The newest bucket in the materialization hypertable.
    pub watermark: Option<String>,
    /// now() minus the watermark, as the server prints an interval.
    pub lag: Option<String>,
    pub policy: Option<JobInfo>,
    /// Continuous aggregates built on this one.
    pub children: Vec<RelationRef>,
    /// Its materialization hypertable's chunks, newest first.
    pub chunks: Vec<ChunkInfo>,
}

/// What `drop_chunks` would remove, read before asking.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropChunksPreview {
    pub chunks: Vec<ChunkInfo>,
    pub total_bytes: i64,
    /// Continuous aggregates over the hypertable: dropping raw chunks keeps
    /// what they already materialized, but a later refresh of that range
    /// would empty it.
    pub dependent_caggs: Vec<RelationRef>,
}

/// The extension, if this database has it.
pub async fn probe(client: &PgClient) -> AppResult<Option<TimescaleInfo>> {
    let _ = client;
    Ok(None)
}

/// Marks the hypertables among `objects.tables` and moves the continuous
/// aggregates out of `objects.views` into `objects.continuous_aggregates`.
/// Called only when `probe` found the extension.
pub async fn annotate_schema_objects(
    client: &PgClient,
    schema: &str,
    objects: &mut super::catalog::SchemaObjects,
) -> AppResult<()> {
    let _ = (client, schema, objects);
    Ok(())
}

/// Fills `hypertable`, `cagg` or `chunk` of a described relation, corrects
/// its size and row estimate, the cagg's definition and the DDL. Called only
/// when `probe` found the extension.
pub async fn annotate_table(
    client: &PgClient,
    info: &mut super::catalog::TableInfo,
    ts: &TimescaleInfo,
) -> AppResult<()> {
    let _ = (client, info, ts);
    Ok(())
}

pub async fn hypertable_detail(
    client: &PgClient,
    schema: &str,
    name: &str,
    ts: &TimescaleInfo,
) -> AppResult<HypertableDetail> {
    let _ = (client, schema, name, ts);
    Ok(HypertableDetail::default())
}

pub async fn cagg_detail(
    client: &PgClient,
    schema: &str,
    name: &str,
    ts: &TimescaleInfo,
) -> AppResult<CaggDetail> {
    let _ = (client, schema, name, ts);
    Ok(CaggDetail::default())
}

/// Every job the role can see, with its last run and last error.
pub async fn jobs(client: &PgClient) -> AppResult<Vec<JobInfo>> {
    let _ = client;
    Ok(Vec::new())
}
