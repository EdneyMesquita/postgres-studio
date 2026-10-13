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

use super::catalog::json_query;
use super::{ident, literal, qualified, PgClient};
use crate::error::{AppError, AppResult};

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
    /// Derived from the procedure after the read, not part of the query.
    #[serde(default)]
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

/// Internal schemas of the extension: a job whose procedure lives there is
/// the extension's own housekeeping, not something the user set up.
const INTERNAL_SCHEMAS: [&str; 2] = ["_timescaledb_functions", "_timescaledb_internal"];

/// Triggers the extension adds to hypertables; they say nothing the
/// hypertable summary doesn't, and a script that recreates the table must
/// not carry them.
const HIDDEN_TRIGGERS: [&str; 2] = ["ts_insert_blocker", "ts_cagg_invalidation_trigger"];

/// `(major, minor)` of an `extversion` such as `2.30.2` or `2.19.0-dev`.
fn parse_version(version: &str) -> (u32, u32) {
    let mut parts = version.split('.').map(|part| {
        part.chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(0)
    });
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// The edition: from `timescaledb.license` when the server has the setting,
/// else from the extension's comment, which ends in the edition's name since
/// 2.17. Unknown means Apache, the one that can't surprise with a failure.
fn edition(setting: Option<&str>, comment: Option<&str>) -> (String, bool) {
    let license = match setting.filter(|s| !s.is_empty()) {
        Some(license) => license.to_string(),
        None if comment.is_some_and(|c| c.contains("(Community Edition)")) => "timescale".into(),
        None => "apache".into(),
    };
    let community = license == "timescale";
    (license, community)
}

#[derive(Deserialize)]
struct RawProbe {
    version: String,
    schema: String,
    license: Option<String>,
    comment: Option<String>,
}

/// The extension, if this database has it. One cheap statement: it runs on
/// every schema listing and table description.
pub async fn probe(client: &PgClient) -> AppResult<Option<TimescaleInfo>> {
    let sql = "SELECT json_build_object(
            'version', e.extversion,
            'schema', (SELECT nspname FROM pg_namespace WHERE oid = e.extnamespace),
            'license', current_setting('timescaledb.license', true),
            'comment', obj_description(e.oid, 'pg_extension'))
        FROM pg_extension e WHERE e.extname = 'timescaledb'";
    let Some(raw) = json_query::<RawProbe>(client, sql).await? else {
        return Ok(None);
    };
    let (major, minor) = parse_version(&raw.version);
    let (license, community) = edition(raw.license.as_deref(), raw.comment.as_deref());
    Ok(Some(TimescaleInfo {
        version: raw.version,
        major,
        minor,
        license,
        schema: raw.schema,
        columnstore_api: (major, minor) >= (2, 18),
        community,
    }))
}

/// The kind of a job from the procedure it runs.
fn job_kind(proc_schema: &str, proc_name: &str) -> &'static str {
    match proc_name {
        "policy_refresh_continuous_aggregate" => "refresh",
        "policy_compression" | "policy_columnstore" | "policy_recompression" => "columnstore",
        "policy_retention" => "retention",
        "policy_reorder" => "reorder",
        _ if INTERNAL_SCHEMAS.contains(&proc_schema) => "internal",
        _ => "custom",
    }
}

/// A job-log or hypertable detail failing must not take the rest of the page
/// with it: log it and fall back to what is empty.
fn soft<T: Default>(what: &str, result: AppResult<T>) -> T {
    result.unwrap_or_else(|e| {
        log::warn!("timescale: {what}: {e}");
        T::default()
    })
}

/// `'text'` for scripts meant to be read and copied.
fn plain(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn regclass(schema: &str, name: &str) -> String {
    format!("{}::regclass", literal(&qualified(schema, name)))
}

#[derive(Deserialize)]
struct ListedHypertable {
    name: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: Option<i64>,
    rows: Option<i64>,
}

#[derive(Deserialize, Default)]
struct Listed {
    hypertables: Vec<ListedHypertable>,
    caggs: Vec<ListedHypertable>,
}

/// Marks the hypertables among `objects.tables` and moves the continuous
/// aggregates out of `objects.views` into `objects.continuous_aggregates`.
/// Called only when `probe` found the extension. The explorer must keep
/// working whatever happens here, so a failure leaves `objects` as it was.
pub async fn annotate_schema_objects(
    client: &PgClient,
    schema: &str,
    objects: &mut super::catalog::SchemaObjects,
) -> AppResult<()> {
    // `hypertable_approximate_size` reads the chunks' relation sizes without
    // the catalog walk `hypertable_size` does: the same figure on the dev
    // server in a third of the time, and the listing runs on every expand.
    let sql = format!(
        "SELECT json_build_object(
            'hypertables', (SELECT coalesce(json_agg(json_build_object(
                    'name', h.hypertable_name,
                    'sizeBytes', hypertable_approximate_size(format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass),
                    'rows', approximate_row_count(format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass)
                ) ORDER BY h.hypertable_name), '[]')
                FROM timescaledb_information.hypertables h WHERE h.hypertable_schema = {schema}),
            'caggs', (SELECT coalesce(json_agg(json_build_object(
                    'name', ca.view_name,
                    'sizeBytes', hypertable_approximate_size(format('%I.%I', ca.materialization_hypertable_schema, ca.materialization_hypertable_name)::regclass),
                    'rows', approximate_row_count(format('%I.%I', ca.materialization_hypertable_schema, ca.materialization_hypertable_name)::regclass)
                ) ORDER BY ca.view_name), '[]')
                FROM timescaledb_information.continuous_aggregates ca WHERE ca.view_schema = {schema})
         )",
        schema = literal(schema)
    );
    let listed: Listed = match json_query(client, &sql).await {
        Ok(listed) => listed.unwrap_or_default(),
        Err(e) => {
            log::warn!("timescale: listing {schema}: {e}");
            return Ok(());
        }
    };
    for h in listed.hypertables {
        if let Some(entry) = objects.tables.iter_mut().find(|t| t.name == h.name) {
            entry.timescale = Some("hypertable".into());
            entry.size_bytes = h.size_bytes;
            entry.row_estimate = h.rows;
        }
    }
    for c in listed.caggs {
        if let Some(at) = objects.views.iter().position(|v| v.name == c.name) {
            let mut entry = objects.views.remove(at);
            entry.timescale = Some("cagg".into());
            entry.size_bytes = c.size_bytes;
            entry.row_estimate = c.rows;
            objects.continuous_aggregates.push(entry);
        }
    }
    Ok(())
}

/// What the three kinds of relation add, read in one statement.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct TableFacts {
    hypertable: Option<HypertableSummary>,
    cagg: Option<CaggSummary>,
    chunk: Option<ChunkParent>,
}

fn table_facts_sql(schema: &str, name: &str) -> String {
    format!(
        "SELECT json_build_object(
            'hypertable', (SELECT json_build_object(
                    'dimensions', (SELECT coalesce(json_agg(json_build_object(
                            'number', d.dimension_number, 'column', d.column_name,
                            'columnType', d.column_type::text, 'kind', d.dimension_type,
                            'timeInterval', d.time_interval::text,
                            'integerInterval', d.integer_interval,
                            'numPartitions', d.num_partitions) ORDER BY d.dimension_number), '[]')
                        FROM timescaledb_information.dimensions d
                        WHERE d.hypertable_schema = h.hypertable_schema AND d.hypertable_name = h.hypertable_name),
                    'numChunks', h.num_chunks,
                    'compressedChunks', (SELECT count(*) FROM timescaledb_information.chunks c
                        WHERE c.hypertable_schema = h.hypertable_schema AND c.hypertable_name = h.hypertable_name
                          AND c.is_compressed),
                    'columnstore', h.compression_enabled,
                    'totalBytes', hypertable_size(format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass),
                    'approxRows', approximate_row_count(format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass))
                FROM timescaledb_information.hypertables h
                WHERE h.hypertable_schema = {schema} AND h.hypertable_name = {name}),
            'cagg', (SELECT json_build_object(
                    'sourceSchema', coalesce(p.view_schema, ca.hypertable_schema),
                    'sourceName', coalesce(p.view_name, ca.hypertable_name),
                    'sourceKind', CASE WHEN p.view_name IS NULL THEN 'hypertable' ELSE 'cagg' END,
                    'materializationSchema', ca.materialization_hypertable_schema,
                    'materializationName', ca.materialization_hypertable_name,
                    'viewDefinition', coalesce(ca.view_definition, ''),
                    'materializedOnly', ca.materialized_only,
                    'columnstore', ca.compression_enabled,
                    'totalBytes', hypertable_size(format('%I.%I', ca.materialization_hypertable_schema, ca.materialization_hypertable_name)::regclass),
                    'approxRows', approximate_row_count(format('%I.%I', ca.materialization_hypertable_schema, ca.materialization_hypertable_name)::regclass))
                FROM timescaledb_information.continuous_aggregates ca
                -- a hierarchical aggregate's hypertable is its parent's materialization
                LEFT JOIN timescaledb_information.continuous_aggregates p
                  ON p.materialization_hypertable_schema = ca.hypertable_schema
                 AND p.materialization_hypertable_name = ca.hypertable_name
                WHERE ca.view_schema = {schema} AND ca.view_name = {name}),
            'chunk', (SELECT json_build_object(
                    'hypertableSchema', c.hypertable_schema, 'hypertableName', c.hypertable_name,
                    'isCompressed', c.is_compressed)
                FROM timescaledb_information.chunks c
                WHERE c.chunk_schema = {schema} AND c.chunk_name = {name})
         )",
        schema = literal(schema),
        name = literal(name),
    )
}

/// Fills `hypertable`, `cagg` or `chunk` of a described relation, corrects
/// its size and row estimate, the cagg's definition and the DDL. Called only
/// when `probe` found the extension. `describe_table` must not fail because
/// of Timescale, so an error leaves `info` as the plain catalog read it.
pub async fn annotate_table(
    client: &PgClient,
    info: &mut super::catalog::TableInfo,
    ts: &TimescaleInfo,
) -> AppResult<()> {
    if !matches!(info.kind.as_str(), "r" | "p" | "v") {
        return Ok(());
    }
    let mut annotated = info.clone();
    match annotate(client, &mut annotated, ts).await {
        Ok(()) => *info = annotated,
        Err(e) => log::warn!("timescale: describing {}.{}: {e}", info.schema, info.name),
    }
    Ok(())
}

async fn annotate(
    client: &PgClient,
    info: &mut super::catalog::TableInfo,
    ts: &TimescaleInfo,
) -> AppResult<()> {
    let facts: TableFacts = json_query(client, &table_facts_sql(&info.schema, &info.name))
        .await?
        .unwrap_or_default();
    let name = qualified(&info.schema, &info.name);
    if let Some(h) = facts.hypertable {
        info.size_bytes = h.total_bytes;
        info.row_estimate = h.approx_rows;
        info.triggers
            .retain(|t| !HIDDEN_TRIGGERS.contains(&t.name.as_str()));
        let settings = if h.columnstore {
            soft(
                "columnstore settings",
                columnstore_settings(client, &info.schema, &info.name, ts).await,
            )
        } else {
            None
        };
        let policies = soft(
            "policies",
            policy_jobs(client, &info.schema, &info.name).await,
        );
        let mut ddl = super::catalog::ddl(info);
        ddl.push('\n');
        ddl.push_str(&hypertable_ddl(
            &name,
            &h,
            settings.as_ref(),
            &policies,
            ts.columnstore_api,
        ));
        info.ddl = ddl;
        info.hypertable = Some(h);
    } else if let Some(mut c) = facts.cagg.filter(|_| info.kind == "v") {
        info.size_bytes = c.total_bytes;
        info.row_estimate = c.approx_rows;
        c.bucket_width = bucket_width(&c.view_definition);
        if !c.view_definition.trim().is_empty() {
            info.view_definition = Some(c.view_definition.clone());
        }
        let policies = soft(
            "refresh policy",
            policy_jobs(client, &info.schema, &info.name).await,
        );
        // what `ddl` writes for any view; the rest (comments, triggers) stays
        let plain_view = format!(
            "CREATE VIEW {name} AS\n{};\n",
            c.view_definition.trim().trim_end_matches(';')
        );
        let rest = super::catalog::ddl(info);
        let rest = rest.strip_prefix(&plain_view).unwrap_or("");
        info.ddl = format!("{}{rest}", cagg_ddl(&name, &c, &policies));
        info.cagg = Some(c);
    } else if let Some(chunk) = facts.chunk {
        info.chunk = Some(chunk);
    }
    Ok(())
}

/// The first `time_bucket(` width in a continuous aggregate's query, as
/// plain words (`1 hour`), or the integer for an integer time column.
/// Postgres prints it as `'01:00:00'::interval`, `'1 day'::interval` or a
/// bare number; `INTERVAL '1 hour'` is what people write.
fn bucket_width(definition: &str) -> Option<String> {
    let lower = definition.to_ascii_lowercase();
    let start = lower.find("time_bucket(")? + "time_bucket(".len();
    let rest = &definition[start..];
    // the first argument ends at the first comma or paren outside quotes
    let mut quoted = false;
    let mut end = rest.len();
    for (i, ch) in rest.char_indices() {
        match ch {
            '\'' => quoted = !quoted,
            ',' | ')' if !quoted => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    let arg = rest[..end].trim();
    let value = match arg.find('\'') {
        Some(open) => {
            let inner = &arg[open + 1..];
            &inner[..inner.find('\'')?]
        }
        None => arg,
    };
    let value = value.trim();
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " :.-+".contains(c))
    {
        return None;
    }
    Some(clock_to_words(value))
}

/// `01:00:00` as `1 hour`, `00:15:00` as `15 minutes`; anything else as is.
fn clock_to_words(value: &str) -> String {
    let parts: Vec<&str> = value.split(':').collect();
    let numbers: Option<Vec<u32>> = parts.iter().map(|p| p.parse().ok()).collect();
    let (Some(n), 3) = (numbers, parts.len()) else {
        return value.to_string();
    };
    let unit =
        |count: u32, word: &str| format!("{count} {word}{}", if count == 1 { "" } else { "s" });
    match (n[0], n[1], n[2]) {
        (h, 0, 0) if h > 0 => unit(h, "hour"),
        (0, m, 0) if m > 0 => unit(m, "minute"),
        (0, 0, s) if s > 0 => unit(s, "second"),
        _ => value.to_string(),
    }
}

/// `INTERVAL '3 days'` for a text setting of a job's config, the bare number
/// for an integer time column, `NULL` for none.
fn interval_arg(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => format!("INTERVAL {}", plain(s)),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => "NULL".to_string(),
    }
}

/// The calls that recreate the policies a relation carries.
fn policy_statements(table: &str, jobs: &[JobInfo], columnstore_api: bool) -> Vec<String> {
    let mut out = Vec::new();
    let key = |job: &JobInfo, names: &[&'static str]| {
        names.iter().find_map(|name| {
            job.config
                .as_ref()
                .and_then(|c| c.get(*name))
                .map(|v| (*name, v.clone()))
        })
    };
    for job in jobs {
        let table = plain(table);
        match job.kind.as_str() {
            "columnstore" => {
                let Some((name, v)) = key(job, &["compress_after", "compress_created_before"])
                else {
                    continue;
                };
                let arg = if name == "compress_after" {
                    "after"
                } else {
                    "created_before"
                };
                let value = interval_arg(Some(&v));
                out.push(if columnstore_api {
                    format!("CALL add_columnstore_policy({table}, {arg} => {value});")
                } else {
                    format!("SELECT add_compression_policy({table}, {name} => {value});")
                });
            }
            "retention" => {
                let Some((name, v)) = key(job, &["drop_after", "drop_created_before"]) else {
                    continue;
                };
                out.push(format!(
                    "SELECT add_retention_policy({table}, {name} => {});",
                    interval_arg(Some(&v))
                ));
            }
            "refresh" => {
                let config = job.config.as_ref();
                let schedule = job
                    .schedule_interval
                    .as_deref()
                    .map(|s| format!("INTERVAL {}", plain(s)))
                    .unwrap_or_else(|| "NULL".to_string());
                out.push(format!(
                    "SELECT add_continuous_aggregate_policy({table}, start_offset => {}, end_offset => {}, schedule_interval => {schedule});",
                    interval_arg(config.and_then(|c| c.get("start_offset"))),
                    interval_arg(config.and_then(|c| c.get("end_offset"))),
                ));
            }
            _ => {}
        }
    }
    out
}

/// What recreates the Timescale side of a hypertable, with the 2.18+ API
/// (the older compression names when the server predates it).
fn hypertable_ddl(
    table: &str,
    h: &HypertableSummary,
    settings: Option<&ColumnstoreSettings>,
    policies: &[JobInfo],
    columnstore_api: bool,
) -> String {
    let mut out = Vec::new();
    let arg = plain(table);
    let by_range = |d: &Dimension| match (&d.time_interval, d.integer_interval) {
        (Some(interval), _) => format!(
            "by_range({}, INTERVAL {})",
            plain(&d.column),
            plain(interval)
        ),
        (None, Some(n)) => format!("by_range({}, {n})", plain(&d.column)),
        (None, None) => format!("by_range({})", plain(&d.column)),
    };
    if let Some(time) = h
        .dimensions
        .iter()
        .find(|d| d.kind.eq_ignore_ascii_case("time"))
    {
        out.push(format!(
            "SELECT create_hypertable({arg}, {});",
            by_range(time)
        ));
    }
    for space in h
        .dimensions
        .iter()
        .filter(|d| d.kind.eq_ignore_ascii_case("space"))
    {
        let partitions = space.num_partitions.unwrap_or(1);
        out.push(format!(
            "SELECT add_dimension({arg}, by_hash({}, {partitions}));",
            plain(&space.column)
        ));
    }
    if h.columnstore {
        let (enable, segmentby, orderby) = if columnstore_api {
            (
                "timescaledb.enable_columnstore = true",
                "timescaledb.segmentby",
                "timescaledb.orderby",
            )
        } else {
            (
                "timescaledb.compress",
                "timescaledb.compress_segmentby",
                "timescaledb.compress_orderby",
            )
        };
        let mut options = vec![enable.to_string()];
        if let Some(s) = settings {
            if !s.segmentby.is_empty() {
                options.push(format!("{segmentby} = {}", plain(&s.segmentby.join(", "))));
            }
            if !s.orderby.is_empty() {
                options.push(format!("{orderby} = {}", plain(&s.orderby.join(", "))));
            }
        }
        out.push(format!("ALTER TABLE {table} SET ({});", options.join(", ")));
    }
    out.extend(policy_statements(table, policies, columnstore_api));
    let mut text = out.join("\n");
    text.push('\n');
    text
}

/// `CREATE MATERIALIZED VIEW` for a continuous aggregate, and its refresh
/// policy when it has one.
fn cagg_ddl(table: &str, cagg: &CaggSummary, policies: &[JobInfo]) -> String {
    let realtime = if cagg.materialized_only {
        ""
    } else {
        ", timescaledb.materialized_only = false"
    };
    let mut out = format!(
        "CREATE MATERIALIZED VIEW {table} WITH (timescaledb.continuous{realtime}) AS\n{}\nWITH NO DATA;\n",
        cagg.view_definition.trim().trim_end_matches(';')
    );
    let refresh: Vec<JobInfo> = policies
        .iter()
        .filter(|j| j.kind == "refresh")
        .cloned()
        .collect();
    for statement in policy_statements(table, &refresh, true) {
        out.push_str(&statement);
        out.push('\n');
    }
    out
}

#[derive(Deserialize, Default)]
struct RawSettings {
    segmentby: Option<String>,
    orderby: Option<String>,
}

fn split_list(text: Option<String>) -> Vec<String> {
    text.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// segmentby and orderby of the columnstore; `None` when neither is set.
async fn columnstore_settings(
    client: &PgClient,
    schema: &str,
    name: &str,
    ts: &TimescaleInfo,
) -> AppResult<Option<ColumnstoreSettings>> {
    let sql = if ts.columnstore_api {
        format!(
            "SELECT json_build_object('segmentby', s.segmentby, 'orderby', s.orderby)
             FROM timescaledb_information.hypertable_columnstore_settings s
             WHERE s.hypertable = {}",
            regclass(schema, name)
        )
    } else {
        format!(
            "SELECT json_build_object(
                'segmentby', string_agg(attname::text, ', ' ORDER BY segmentby_column_index)
                    FILTER (WHERE segmentby_column_index IS NOT NULL),
                'orderby', string_agg(format('%I %s', attname, CASE WHEN orderby_asc THEN 'ASC' ELSE 'DESC' END),
                    ', ' ORDER BY orderby_column_index) FILTER (WHERE orderby_column_index IS NOT NULL))
             FROM timescaledb_information.compression_settings
             WHERE hypertable_schema = {} AND hypertable_name = {}",
            literal(schema),
            literal(name)
        )
    };
    let raw: RawSettings = json_query(client, &sql).await?.unwrap_or_default();
    let settings = ColumnstoreSettings {
        segmentby: split_list(raw.segmentby),
        orderby: split_list(raw.orderby),
    };
    Ok((!settings.segmentby.is_empty() || !settings.orderby.is_empty()).then_some(settings))
}

fn chunks_sql(schema: &str, name: &str, ts: &TimescaleInfo) -> String {
    let stats = if ts.columnstore_api {
        "chunk_columnstore_stats"
    } else {
        "chunk_compression_stats"
    };
    let table = regclass(schema, name);
    format!(
        "SELECT coalesce(json_agg(json_build_object(
                'schema', c.chunk_schema, 'name', c.chunk_name,
                'rangeStart', coalesce(c.range_start::text, c.range_start_integer::text),
                'rangeEnd', coalesce(c.range_end::text, c.range_end_integer::text),
                'isCompressed', c.is_compressed,
                'totalBytes', s.total_bytes,
                'beforeBytes', cs.before_compression_total_bytes,
                'afterBytes', cs.after_compression_total_bytes)
            ORDER BY c.range_start DESC NULLS LAST, c.range_start_integer DESC NULLS LAST, c.chunk_name DESC), '[]')
         FROM timescaledb_information.chunks c
         LEFT JOIN chunks_detailed_size({table}) s
           ON s.chunk_schema = c.chunk_schema AND s.chunk_name = c.chunk_name
         LEFT JOIN {stats}({table}) cs
           ON cs.chunk_schema = c.chunk_schema AND cs.chunk_name = c.chunk_name
         WHERE c.hypertable_schema = {schema} AND c.hypertable_name = {name}",
        schema = literal(schema),
        name = literal(name),
    )
}

async fn chunks(
    client: &PgClient,
    schema: &str,
    name: &str,
    ts: &TimescaleInfo,
) -> AppResult<Vec<ChunkInfo>> {
    Ok(json_query(client, &chunks_sql(schema, name, ts))
        .await?
        .unwrap_or_default())
}

async fn totals(
    client: &PgClient,
    schema: &str,
    name: &str,
    ts: &TimescaleInfo,
) -> AppResult<Option<CompressionTotals>> {
    // no rows while the columnstore is off
    let stats = if ts.columnstore_api {
        "hypertable_columnstore_stats"
    } else {
        "hypertable_compression_stats"
    };
    let sql = format!(
        "SELECT json_build_object(
            'totalChunks', total_chunks, 'compressedChunks', number_compressed_chunks,
            'beforeBytes', before_compression_total_bytes, 'afterBytes', after_compression_total_bytes)
         FROM {stats}({})",
        regclass(schema, name)
    );
    json_query(client, &sql).await
}

fn jobs_sql(target: Option<(&str, &str)>, with_errors: bool) -> String {
    let last_error = if with_errors {
        "LEFT JOIN LATERAL (
            SELECT je.err_message, je.finish_time FROM timescaledb_information.job_errors je
            WHERE je.job_id = j.job_id ORDER BY je.finish_time DESC LIMIT 1) e ON true"
    } else {
        "LEFT JOIN (SELECT NULL::text AS err_message, NULL::timestamptz AS finish_time) e ON true"
    };
    let filter = target
        .map(|(schema, name)| {
            format!(
                "WHERE j.hypertable_schema = {} AND j.hypertable_name = {}",
                literal(schema),
                literal(name)
            )
        })
        .unwrap_or_default();
    format!(
        "SELECT coalesce(json_agg(json_build_object(
                'jobId', j.job_id, 'applicationName', j.application_name,
                'procSchema', j.proc_schema, 'procName', j.proc_name,
                'targetSchema', j.hypertable_schema, 'targetName', j.hypertable_name,
                'scheduleInterval', j.schedule_interval::text, 'scheduled', j.scheduled,
                'config', j.config, 'owner', j.owner::text,
                'lastRunStatus', s.last_run_status, 'jobStatus', s.job_status,
                'lastRunStartedAt', nullif(s.last_run_started_at::text, '-infinity'),
                'lastSuccessfulFinish', nullif(s.last_successful_finish::text, '-infinity'),
                'lastRunDuration', s.last_run_duration::text,
                'nextStart', coalesce(s.next_start, j.next_start)::text,
                'totalRuns', s.total_runs, 'totalFailures', s.total_failures,
                'lastError', e.err_message, 'lastErrorAt', e.finish_time::text
            ) ORDER BY j.job_id), '[]')
         FROM timescaledb_information.jobs j
         LEFT JOIN timescaledb_information.job_stats s ON s.job_id = j.job_id
         {last_error}
         {filter}"
    )
}

async fn fetch_jobs(client: &PgClient, target: Option<(&str, &str)>) -> AppResult<Vec<JobInfo>> {
    // job_errors filters by the job's owner and can be unreadable for a role
    // that can read everything else: the page then loses only the last error
    let found = match json_query::<Vec<JobInfo>>(client, &jobs_sql(target, true)).await {
        Ok(found) => found,
        Err(e) => {
            log::warn!("timescale: job errors unavailable: {e}");
            json_query(client, &jobs_sql(target, false)).await?
        }
    };
    let mut jobs = found.unwrap_or_default();
    for job in &mut jobs {
        job.kind = job_kind(&job.proc_schema, &job.proc_name).to_string();
    }
    Ok(jobs)
}

/// The jobs attached to one relation: a hypertable's policies, or for a
/// continuous aggregate its refresh policy.
async fn policy_jobs(client: &PgClient, schema: &str, name: &str) -> AppResult<Vec<JobInfo>> {
    fetch_jobs(client, Some((schema, name))).await
}

pub async fn hypertable_detail(
    client: &PgClient,
    schema: &str,
    name: &str,
    ts: &TimescaleInfo,
) -> AppResult<HypertableDetail> {
    let chunks = chunks(client, schema, name, ts).await?;
    let settings = soft(
        "columnstore settings",
        columnstore_settings(client, schema, name, ts).await,
    );
    let totals = soft("columnstore totals", totals(client, schema, name, ts).await);
    let policies = soft("policies", policy_jobs(client, schema, name).await);
    let sql = format!(
        "SELECT coalesce(json_agg(json_build_object('schema', ca.view_schema, 'name', ca.view_name)
                ORDER BY ca.view_schema, ca.view_name), '[]')
         FROM timescaledb_information.continuous_aggregates ca
         WHERE ca.hypertable_schema = {} AND ca.hypertable_name = {}",
        literal(schema),
        literal(name)
    );
    let caggs = soft(
        "dependent aggregates",
        json_query(client, &sql)
            .await
            .map(Option::unwrap_or_default),
    );
    Ok(HypertableDetail {
        chunks,
        settings,
        totals,
        policies,
        caggs,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaggLocation {
    mat_schema: String,
    mat_name: String,
    time_column: Option<String>,
    time_type: Option<String>,
    children: Vec<RelationRef>,
}

#[derive(Deserialize)]
struct Watermark {
    watermark: Option<String>,
    lag: Option<String>,
}

/// The newest bucket of the materialization hypertable. Its own statement,
/// guarded by the privilege: a role without SELECT on it, or any other
/// failure, costs this field only.
async fn watermark(
    client: &PgClient,
    loc: &CaggLocation,
) -> (String, Option<String>, Option<String>) {
    let unavailable = || ("unavailable".to_string(), None, None);
    let Some(column) = &loc.time_column else {
        return unavailable();
    };
    let table = qualified(&loc.mat_schema, &loc.mat_name);
    let allowed = format!(
        "SELECT to_json(has_table_privilege({}, 'SELECT'))",
        literal(&table)
    );
    match json_query::<bool>(client, &allowed).await {
        Ok(Some(true)) => {}
        Ok(_) => return unavailable(),
        Err(e) => {
            log::warn!("timescale: watermark privilege of {table}: {e}");
            return unavailable();
        }
    }
    // an integer time column has no clock to measure a lag against
    let lag = match loc.time_type.as_deref() {
        Some("timestamp with time zone") => "(now() - m)::text",
        Some("timestamp without time zone") => "(localtimestamp - m)::text",
        Some("date") => "(localtimestamp - m::timestamp)::text",
        _ => "NULL",
    };
    let sql = format!(
        "SELECT json_build_object('watermark', m::text, 'lag', {lag})
         FROM (SELECT max({}) AS m FROM {table}) t",
        ident(column)
    );
    match json_query::<Watermark>(client, &sql).await {
        Ok(Some(w)) if w.watermark.is_some() => ("ok".to_string(), w.watermark, w.lag),
        Ok(_) => ("never".to_string(), None, None),
        Err(e) => {
            log::warn!("timescale: watermark of {table}: {e}");
            unavailable()
        }
    }
}

pub async fn cagg_detail(
    client: &PgClient,
    schema: &str,
    name: &str,
    ts: &TimescaleInfo,
) -> AppResult<CaggDetail> {
    let sql = format!(
        "SELECT json_build_object(
            'matSchema', ca.materialization_hypertable_schema,
            'matName', ca.materialization_hypertable_name,
            'timeColumn', d.column_name, 'timeType', d.column_type::text,
            'children', (SELECT coalesce(json_agg(json_build_object('schema', ch.view_schema, 'name', ch.view_name)
                    ORDER BY ch.view_schema, ch.view_name), '[]')
                FROM timescaledb_information.continuous_aggregates ch
                WHERE ch.hypertable_schema = ca.materialization_hypertable_schema
                  AND ch.hypertable_name = ca.materialization_hypertable_name))
         FROM timescaledb_information.continuous_aggregates ca
         LEFT JOIN timescaledb_information.dimensions d
           ON d.hypertable_schema = ca.materialization_hypertable_schema
          AND d.hypertable_name = ca.materialization_hypertable_name
          AND d.dimension_number = 1
         WHERE ca.view_schema = {} AND ca.view_name = {}",
        literal(schema),
        literal(name)
    );
    let loc: CaggLocation = json_query(client, &sql)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("continuous aggregate {schema}.{name}")))?;
    let (watermark_state, watermark, lag) = watermark(client, &loc).await;
    let policy = soft("refresh policy", policy_jobs(client, schema, name).await)
        .into_iter()
        .find(|j| j.kind == "refresh");
    let chunks = soft(
        "materialization chunks",
        chunks(client, &loc.mat_schema, &loc.mat_name, ts).await,
    );
    Ok(CaggDetail {
        watermark_state,
        watermark,
        lag,
        policy,
        children: loc.children,
        chunks,
    })
}

/// Every job the role can see, with its last run and last error.
pub async fn jobs(client: &PgClient) -> AppResult<Vec<JobInfo>> {
    fetch_jobs(client, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions_are_read_from_extversion() {
        assert_eq!(parse_version("2.30.2"), (2, 30));
        assert_eq!(parse_version("2.9.1"), (2, 9));
        assert_eq!(parse_version("2.19.0-dev"), (2, 19));
        assert_eq!(parse_version("2.18"), (2, 18));
        assert_eq!(parse_version("garbage"), (0, 0));
        // 2.9 is older than 2.18 even though "9" > "18" as text
        assert!((2, 9) < (2, 18) && (2, 18) <= (2, 18) && (2, 30) >= (2, 18));
    }

    #[test]
    fn the_edition_falls_back_to_the_extension_comment() {
        assert_eq!(edition(Some("timescale"), None), ("timescale".into(), true));
        assert_eq!(
            edition(Some("apache"), Some("(Community Edition)")),
            ("apache".into(), false)
        );
        assert_eq!(
            edition(None, Some("Enables x (Community Edition)")),
            ("timescale".into(), true)
        );
        assert_eq!(
            edition(None, Some("Enables x (Apache 2 Edition)")),
            ("apache".into(), false)
        );
        assert_eq!(edition(Some(""), None), ("apache".into(), false));
        assert_eq!(edition(None, None), ("apache".into(), false));
    }

    #[test]
    fn jobs_are_classified_by_their_procedure() {
        let f = "_timescaledb_functions";
        assert_eq!(
            job_kind(f, "policy_refresh_continuous_aggregate"),
            "refresh"
        );
        assert_eq!(job_kind(f, "policy_compression"), "columnstore");
        assert_eq!(job_kind(f, "policy_columnstore"), "columnstore");
        assert_eq!(job_kind(f, "policy_retention"), "retention");
        assert_eq!(job_kind(f, "policy_reorder"), "reorder");
        assert_eq!(job_kind(f, "policy_telemetry"), "internal");
        assert_eq!(job_kind("_timescaledb_internal", "anything"), "internal");
        assert_eq!(job_kind("public", "failing_job"), "custom");
        // a user's procedure that shares a policy's name is still a policy name
        // only in the extension's schema; elsewhere the name decides, not the schema
        assert_eq!(job_kind("public", "my_job"), "custom");
    }

    #[test]
    fn bucket_widths_come_from_the_first_time_bucket() {
        let w = |s: &str| bucket_width(s);
        assert_eq!(
            w("SELECT time_bucket('01:00:00'::interval, \"time\") AS bucket FROM m"),
            Some("1 hour".into())
        );
        assert_eq!(
            w("SELECT time_bucket('1 day'::interval, bucket) FROM x"),
            Some("1 day".into())
        );
        assert_eq!(
            w("SELECT time_bucket(INTERVAL '1 hour', t) FROM x"),
            Some("1 hour".into())
        );
        assert_eq!(
            w("SELECT TIME_BUCKET(INTERVAL '15 minutes', t)"),
            Some("15 minutes".into())
        );
        assert_eq!(
            w("SELECT time_bucket('00:15:00'::interval, t)"),
            Some("15 minutes".into())
        );
        assert_eq!(
            w("SELECT time_bucket('00:00:30'::interval, t)"),
            Some("30 seconds".into())
        );
        assert_eq!(
            w("SELECT time_bucket('02:30:00'::interval, t)"),
            Some("02:30:00".into())
        );
        assert_eq!(
            w("SELECT time_bucket(1000, ts) FROM x"),
            Some("1000".into())
        );
        assert_eq!(
            w("SELECT time_bucket('1000'::bigint, ts) FROM x"),
            Some("1000".into())
        );
        assert_eq!(
            w("SELECT time_bucket('7 days'::interval, m.\"time\", 'Europe/Berlin'::text)"),
            Some("7 days".into())
        );
        assert_eq!(w("SELECT time_bucket(width_col, t) FROM x"), None);
        assert_eq!(w("SELECT date_trunc('day', t) FROM x"), None);
        assert_eq!(w("SELECT time_bucket("), None);
    }

    fn job(kind: &str, schedule: Option<&str>, config: serde_json::Value) -> JobInfo {
        JobInfo {
            job_id: 1,
            application_name: String::new(),
            proc_schema: String::new(),
            proc_name: String::new(),
            kind: kind.into(),
            target_schema: None,
            target_name: None,
            schedule_interval: schedule.map(str::to_string),
            scheduled: true,
            config: Some(config),
            owner: None,
            last_run_status: None,
            job_status: None,
            last_run_started_at: None,
            last_successful_finish: None,
            last_run_duration: None,
            next_start: None,
            total_runs: None,
            total_failures: None,
            last_error: None,
            last_error_at: None,
        }
    }

    fn dimension(
        kind: &str,
        column: &str,
        interval: Option<&str>,
        parts: Option<i32>,
    ) -> Dimension {
        Dimension {
            number: 1,
            column: column.into(),
            column_type: "timestamp with time zone".into(),
            kind: kind.into(),
            time_interval: interval.map(str::to_string),
            integer_interval: None,
            num_partitions: parts,
        }
    }

    #[test]
    fn a_hypertable_script_recreates_its_timescale_side() {
        let h = HypertableSummary {
            dimensions: vec![
                dimension("Time", "time", Some("1 day"), None),
                dimension("Space", "device_id", None, Some(4)),
            ],
            num_chunks: 3,
            compressed_chunks: 1,
            columnstore: true,
            total_bytes: None,
            approx_rows: None,
        };
        let settings = ColumnstoreSettings {
            segmentby: vec!["device_id".into()],
            orderby: vec!["\"time\" DESC".into()],
        };
        let jobs = [
            job(
                "columnstore",
                Some("12:00:00"),
                json!({"compress_after": "7 days"}),
            ),
            job("retention", Some("1 day"), json!({"drop_after": "90 days"})),
            job("custom", None, json!({})),
        ];
        let sql = hypertable_ddl("\"public\".\"metrics\"", &h, Some(&settings), &jobs, true);
        assert!(sql.contains("SELECT create_hypertable('\"public\".\"metrics\"', by_range('time', INTERVAL '1 day'));"), "{sql}");
        assert!(
            sql.contains(
                "SELECT add_dimension('\"public\".\"metrics\"', by_hash('device_id', 4));"
            ),
            "{sql}"
        );
        assert!(sql.contains("ALTER TABLE \"public\".\"metrics\" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'device_id', timescaledb.orderby = '\"time\" DESC');"), "{sql}");
        assert!(sql.contains("CALL add_columnstore_policy('\"public\".\"metrics\"', after => INTERVAL '7 days');"), "{sql}");
        assert!(sql.contains("SELECT add_retention_policy('\"public\".\"metrics\"', drop_after => INTERVAL '90 days');"), "{sql}");
        let old = hypertable_ddl("\"public\".\"metrics\"", &h, None, &jobs, false);
        assert!(old.contains("SET (timescaledb.compress);"), "{old}");
        assert!(old.contains("SELECT add_compression_policy('\"public\".\"metrics\"', compress_after => INTERVAL '7 days');"), "{old}");
    }

    #[test]
    fn a_cagg_script_carries_its_query_and_refresh_policy() {
        let cagg = CaggSummary {
            source_schema: "public".into(),
            source_name: "metrics".into(),
            source_kind: "hypertable".into(),
            materialization_schema: "_timescaledb_internal".into(),
            materialization_name: "_materialized_hypertable_3".into(),
            view_definition: " SELECT time_bucket('01:00:00'::interval, \"time\") AS bucket\n   FROM metrics\n  GROUP BY 1;".into(),
            materialized_only: false,
            columnstore: false,
            bucket_width: None,
            total_bytes: None,
            approx_rows: None,
        };
        let policy = job(
            "refresh",
            Some("00:30:00"),
            json!({"start_offset": "3 days", "end_offset": null}),
        );
        let sql = cagg_ddl("\"public\".\"m\"", &cagg, &[policy]);
        assert!(sql.starts_with("CREATE MATERIALIZED VIEW \"public\".\"m\" WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS\nSELECT time_bucket"), "{sql}");
        assert!(sql.contains("GROUP BY 1\nWITH NO DATA;\n"), "{sql}");
        assert!(sql.contains("SELECT add_continuous_aggregate_policy('\"public\".\"m\"', start_offset => INTERVAL '3 days', end_offset => NULL, schedule_interval => INTERVAL '00:30:00');"), "{sql}");
        let materialized = CaggSummary {
            materialized_only: true,
            ..cagg
        };
        assert!(cagg_ddl("\"public\".\"m\"", &materialized, &[])
            .contains("WITH (timescaledb.continuous) AS"));
    }

    #[test]
    fn settings_lists_split_on_commas() {
        assert_eq!(split_list(Some("a, b".into())), ["a", "b"]);
        assert!(split_list(None).is_empty());
        assert!(split_list(Some(String::new())).is_empty());
    }
}

#[cfg(test)]
mod live_tests {
    //! Against the TimescaleDB container the seed in
    //! scripts/seed-dev-timescale.sql builds (and, for the last test, the
    //! plain dev server). Each test returns early when its variable isn't set:
    //!   POSTGRES_STUDIO_TIMESCALE_URI=postgres://postgres:postgres@localhost:5436/tsdb \
    //!   POSTGRES_STUDIO_TEST_URI=postgres://postgres:postgres@localhost:5433/shop \
    //!     cargo test --lib -- --ignored timescale
    use super::*;
    use crate::models::{
        ConnectionAdvancedOptions, ConnectionProfile, ConnectionSource, SslMode, TlsOptions,
    };
    use crate::pg::{catalog, graph, PgSession};
    use crate::secrets::InMemoryStore;
    use std::sync::Arc;

    async fn session(var: &str) -> Option<PgSession> {
        match std::env::var(var) {
            Ok(uri) => Some(connect(uri).await),
            Err(_) => {
                eprintln!("skipped: {var} is not set");
                None
            }
        }
    }

    async fn connect(uri: String) -> PgSession {
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
        PgSession::connect(&profile, &InMemoryStore::new(), &known)
            .await
            .unwrap()
    }

    #[tokio::test]
    #[ignore]
    async fn live_probe_and_listing() {
        let Some(s) = session("POSTGRES_STUDIO_TIMESCALE_URI").await else {
            return;
        };
        let c = s.client(&s.target.default_db).await.unwrap();
        let ts = probe(&c).await.unwrap().expect("extension installed");
        assert_eq!((ts.major, ts.minor), (2, 30), "{ts:?}");
        assert!(ts.community && ts.columnstore_api, "{ts:?}");
        assert_eq!(ts.license, "timescale");
        assert_eq!(ts.schema, "public");
        assert!(graph::graph_catalog(&c).await.unwrap().timescale.is_some());

        let started = std::time::Instant::now();
        let objects = catalog::list_schema_objects(&c, "public").await.unwrap();
        eprintln!("list_schema_objects(public) took {:?}", started.elapsed());
        for name in ["metrics", "events"] {
            let t = objects.tables.iter().find(|t| t.name == name).unwrap();
            assert_eq!(t.timescale.as_deref(), Some("hypertable"), "{name}");
            assert!(t.size_bytes.unwrap() > 1_000_000, "{name}: {t:?}");
            assert!(t.row_estimate.unwrap() > 1000, "{name}: {t:?}");
        }
        let devices = objects.tables.iter().find(|t| t.name == "devices").unwrap();
        assert!(devices.timescale.is_none() && devices.size_bytes.is_none());
        for name in ["metrics_hourly", "metrics_daily", "events_daily"] {
            let v = objects
                .continuous_aggregates
                .iter()
                .find(|v| v.name == name)
                .unwrap_or_else(|| panic!("{name} not among the aggregates"));
            assert_eq!(v.timescale.as_deref(), Some("cagg"));
            assert!(v.size_bytes.is_some());
            assert!(
                !objects.views.iter().any(|x| x.name == name),
                "{name} still a view"
            );
        }
        let other = catalog::list_schema_objects(&c, "Telemetry").await.unwrap();
        let readings = other
            .tables
            .iter()
            .find(|t| t.name == "Sensor Readings")
            .unwrap();
        assert_eq!(readings.timescale.as_deref(), Some("hypertable"));
        s.shutdown().await;
    }

    #[tokio::test]
    #[ignore]
    async fn live_describe_table() {
        let Some(s) = session("POSTGRES_STUDIO_TIMESCALE_URI").await else {
            return;
        };
        let c = s.client(&s.target.default_db).await.unwrap();

        let metrics = catalog::describe_table(&c, "public", "metrics")
            .await
            .unwrap();
        let h = metrics.hypertable.as_ref().expect("hypertable summary");
        assert!(h.num_chunks >= 30 && h.compressed_chunks > 10, "{h:?}");
        assert!(h.columnstore);
        assert_eq!(h.dimensions[0].column, "time");
        assert_eq!(h.dimensions[0].time_interval.as_deref(), Some("1 day"));
        assert!(
            metrics.size_bytes.unwrap() > 10_000_000,
            "{:?}",
            metrics.size_bytes
        );
        assert!(metrics.row_estimate.unwrap() > 100_000);
        assert!(
            metrics.ddl.contains("CREATE TABLE \"public\".\"metrics\""),
            "{}",
            metrics.ddl
        );
        assert!(
            metrics.ddl.contains(
                "create_hypertable('\"public\".\"metrics\"', by_range('time', INTERVAL '1 day'))"
            ),
            "{}",
            metrics.ddl
        );
        assert!(
            metrics.ddl.contains("timescaledb.segmentby = 'device_id'"),
            "{}",
            metrics.ddl
        );
        assert!(
            metrics.ddl.contains("add_columnstore_policy"),
            "{}",
            metrics.ddl
        );
        assert!(
            metrics.ddl.contains("add_retention_policy"),
            "{}",
            metrics.ddl
        );
        assert!(metrics.triggers.iter().all(|t| !t.name.starts_with("ts_")));

        let hourly = catalog::describe_table(&c, "public", "metrics_hourly")
            .await
            .unwrap();
        let cagg = hourly.cagg.as_ref().expect("cagg summary");
        assert_eq!(cagg.source_kind, "hypertable");
        assert_eq!(cagg.source_name, "metrics");
        assert_eq!(cagg.bucket_width.as_deref(), Some("1 hour"));
        assert!(cagg.materialized_only);
        let def = hourly.view_definition.as_deref().unwrap();
        assert!(
            def.contains("time_bucket") && !def.contains("_materialized_hypertable"),
            "{def}"
        );
        assert!(hourly.size_bytes.unwrap() > 0);
        assert!(hourly.ddl.starts_with("CREATE MATERIALIZED VIEW \"public\".\"metrics_hourly\" WITH (timescaledb.continuous) AS"), "{}", hourly.ddl);
        assert!(
            hourly.ddl.contains("add_continuous_aggregate_policy"),
            "{}",
            hourly.ddl
        );
        // the explorer's "Show definition" serves the same script
        let shown = catalog::object_definition(&c, "public", "metrics_hourly", "view", None)
            .await
            .unwrap();
        assert_eq!(shown, hourly.ddl);

        let daily = catalog::describe_table(&c, "public", "metrics_daily")
            .await
            .unwrap();
        let cagg = daily.cagg.as_ref().unwrap();
        assert_eq!(cagg.source_kind, "cagg");
        assert_eq!(cagg.source_name, "metrics_hourly");
        assert_eq!(cagg.bucket_width.as_deref(), Some("1 day"));
        assert!(!cagg.materialized_only);
        assert!(
            daily.ddl.contains("timescaledb.materialized_only = false"),
            "{}",
            daily.ddl
        );

        let chunk = metrics_chunk(&c).await;
        let described = catalog::describe_table(&c, &chunk.0, &chunk.1)
            .await
            .unwrap();
        let parent = described.chunk.as_ref().expect("chunk parent");
        assert_eq!(
            (
                parent.hypertable_schema.as_str(),
                parent.hypertable_name.as_str()
            ),
            ("public", "metrics")
        );
        assert!(described.hypertable.is_none() && described.cagg.is_none());

        let readings = catalog::describe_table(&c, "Telemetry", "Sensor Readings")
            .await
            .unwrap();
        assert!(readings.hypertable.is_some());
        assert!(readings.ddl.contains("create_hypertable('\"Telemetry\".\"Sensor Readings\"', by_range('Time', INTERVAL '1 day'))"), "{}", readings.ddl);

        let devices = catalog::describe_table(&c, "public", "devices")
            .await
            .unwrap();
        assert!(devices.hypertable.is_none() && devices.cagg.is_none() && devices.chunk.is_none());
        s.shutdown().await;
    }

    async fn metrics_chunk(c: &PgClient) -> (String, String) {
        let chunks = hypertable_detail(c, "public", "metrics", &probe(c).await.unwrap().unwrap())
            .await
            .unwrap()
            .chunks;
        let chunk = chunks.last().unwrap();
        (chunk.schema.clone(), chunk.name.clone())
    }

    #[tokio::test]
    #[ignore]
    async fn live_details_and_jobs() {
        let Some(s) = session("POSTGRES_STUDIO_TIMESCALE_URI").await else {
            return;
        };
        let c = s.client(&s.target.default_db).await.unwrap();
        let ts = probe(&c).await.unwrap().unwrap();

        let d = hypertable_detail(&c, "public", "metrics", &ts)
            .await
            .unwrap();
        assert!(d.chunks.len() >= 30, "{}", d.chunks.len());
        let starts: Vec<_> = d
            .chunks
            .iter()
            .map(|c| c.range_start.clone().unwrap())
            .collect();
        assert!(
            starts.windows(2).all(|w| w[0] >= w[1]),
            "newest first: {starts:?}"
        );
        let compressed: Vec<_> = d.chunks.iter().filter(|c| c.is_compressed).collect();
        assert!(!compressed.is_empty());
        for chunk in &compressed {
            assert!(
                chunk.before_bytes.unwrap() > chunk.after_bytes.unwrap(),
                "{chunk:?}"
            );
        }
        assert!(d
            .chunks
            .iter()
            .filter(|c| !c.is_compressed)
            .all(|c| c.before_bytes.is_none()));
        let settings = d.settings.unwrap();
        assert_eq!(settings.segmentby, ["device_id"]);
        assert_eq!(settings.orderby, ["\"time\" DESC"]);
        let totals = d.totals.unwrap();
        assert_eq!(totals.total_chunks as usize, d.chunks.len());
        assert!(totals.before_bytes.unwrap() > totals.after_bytes.unwrap());
        assert_eq!(d.policies.len(), 2, "{:?}", d.policies);
        assert!(d.policies.iter().any(|p| p.kind == "columnstore"));
        assert!(d.policies.iter().any(|p| p.kind == "retention"));
        assert!(d.caggs.iter().any(|r| r.name == "metrics_hourly"));

        let events = hypertable_detail(&c, "public", "events", &ts)
            .await
            .unwrap();
        assert!(events.settings.is_none() && events.totals.is_none() && events.policies.is_empty());

        let hourly = cagg_detail(&c, "public", "metrics_hourly", &ts)
            .await
            .unwrap();
        assert_eq!(hourly.watermark_state, "ok", "{hourly:?}");
        assert!(hourly.watermark.is_some() && hourly.lag.is_some());
        assert_eq!(hourly.policy.as_ref().unwrap().kind, "refresh");
        assert!(hourly.children.iter().any(|r| r.name == "metrics_daily"));
        assert!(!hourly.chunks.is_empty());
        // the seed's events_daily starts never refreshed, but the actions tests
        // refresh it: a cagg of this test's own shows the "never" state
        let events_daily = cagg_detail(&c, "public", "events_daily", &ts)
            .await
            .unwrap();
        assert!(events_daily.policy.is_none());
        c.client
            .batch_execute("DROP MATERIALIZED VIEW IF EXISTS public.studio_never_cagg")
            .await
            .unwrap();
        c.client
            .batch_execute(
                "CREATE MATERIALIZED VIEW public.studio_never_cagg WITH (timescaledb.continuous) AS \
                 SELECT time_bucket('1 day', at) AS day, count(*) AS total FROM public.events GROUP BY 1 \
                 WITH NO DATA",
            )
            .await
            .unwrap();
        let never = cagg_detail(&c, "public", "studio_never_cagg", &ts).await;
        c.client
            .batch_execute("DROP MATERIALIZED VIEW public.studio_never_cagg")
            .await
            .unwrap();
        let never = never.unwrap();
        assert_eq!(never.watermark_state, "never");
        assert!(never.watermark.is_none() && never.lag.is_none() && never.policy.is_none());
        assert!(cagg_detail(&c, "public", "devices", &ts).await.is_err());

        let all = jobs(&c).await.unwrap();
        let failing = all.iter().find(|j| j.proc_name == "failing_job").unwrap();
        assert_eq!(failing.kind, "custom");
        assert!(
            failing
                .last_error
                .as_deref()
                .unwrap()
                .starts_with("boom from job"),
            "{failing:?}"
        );
        assert!(failing.owner.is_some() && failing.total_failures.unwrap() >= 1);
        assert!(all.iter().any(|j| j.kind == "internal"));
        assert!(all
            .iter()
            .any(|j| j.kind == "refresh" && j.target_name.as_deref() == Some("metrics_hourly")));
        s.shutdown().await;
    }

    /// Nothing changes on a database without the extension.
    #[tokio::test]
    #[ignore]
    async fn live_plain_database_is_untouched() {
        let Some(s) = session("POSTGRES_STUDIO_TEST_URI").await else {
            return;
        };
        let c = s.client(&s.target.default_db).await.unwrap();
        assert!(graph::graph_catalog(&c).await.unwrap().timescale.is_none());
        let objects = catalog::list_schema_objects(&c, "public").await.unwrap();
        assert!(objects.continuous_aggregates.is_empty());
        assert!(objects
            .tables
            .iter()
            .chain(&objects.views)
            .all(|t| t.timescale.is_none() && t.size_bytes.is_none()));
        s.shutdown().await;
    }
}
