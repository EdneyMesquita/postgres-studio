//! Catalog reads: databases, schemas, the objects in a schema, and a
//! table's full description.
//!
//! Each read is one statement that builds its answer as JSON on the server
//! (`json_agg`), so arrays and nulls arrive intact through the text protocol
//! and serde does the rest. Names are spliced in as dollar-quoted literals.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio_postgres::SimpleQueryMessage;

use super::{literal, qualified, PgClient};
use crate::error::{AppError, AppResult};

/// Runs a statement that returns one JSON value and parses it.
pub async fn json_query<T: DeserializeOwned>(client: &PgClient, sql: &str) -> AppResult<Option<T>> {
    let messages = client.client.simple_query(sql).await?;
    let text = messages.iter().find_map(|m| match m {
        SimpleQueryMessage::Row(r) => Some(r.get(0).map(str::to_string)),
        _ => None,
    });
    match text.flatten() {
        Some(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| AppError::InvalidInput(format!("unexpected catalog answer: {e}"))),
        None => Ok(None),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub size_bytes: Option<i64>,
    pub owner: Option<String>,
    pub encoding: Option<String>,
    pub comment: Option<String>,
}

pub async fn list_databases(client: &PgClient) -> AppResult<Vec<DatabaseInfo>> {
    let sql = "SELECT coalesce(json_agg(x ORDER BY x.name), '[]') FROM (
        SELECT d.datname AS name,
               CASE WHEN has_database_privilege(d.oid, 'CONNECT') THEN pg_database_size(d.oid) END AS \"sizeBytes\",
               pg_get_userbyid(d.datdba) AS owner,
               pg_encoding_to_char(d.encoding) AS encoding,
               shobj_description(d.oid, 'pg_database') AS comment
        FROM pg_database d
        WHERE d.datallowconn AND NOT d.datistemplate
    ) x";
    Ok(json_query(client, sql).await?.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    pub owner: Option<String>,
    /// `pg_catalog`, `information_schema` and the like.
    pub system: bool,
    pub comment: Option<String>,
}

pub async fn list_schemas(client: &PgClient) -> AppResult<Vec<SchemaInfo>> {
    // Apache AGE's own schema and the ones it makes for its graphs belong
    // to no extension in `pg_depend`, yet hold nothing to browse. `ag_graph`
    // exists only with AGE, so it is read only after checking for it.
    let age_graphs = if super::graph::age_installed(client).await.unwrap_or(false) {
        "OR n.nspname = 'ag_catalog' OR n.oid IN (SELECT namespace::oid FROM ag_catalog.ag_graph)"
    } else {
        ""
    };
    let sql = format!(
        "SELECT coalesce(json_agg(x ORDER BY x.system, x.name), '[]') FROM (
        SELECT n.nspname AS name,
               pg_get_userbyid(n.nspowner) AS owner,
               (n.nspname IN ('pg_catalog', 'information_schema') OR n.nspname LIKE 'pg\\_%'
                -- created by an extension, like TimescaleDB's _timescaledb_*
                OR EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.classid = 'pg_namespace'::regclass AND d.objid = n.oid
                             AND d.deptype = 'e')
                {age_graphs}) AS system,
               obj_description(n.oid, 'pg_namespace') AS comment
        FROM pg_namespace n
        WHERE n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
    ) x"
    );
    Ok(json_query(client, &sql).await?.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationEntry {
    pub name: String,
    /// `r` table, `p` partitioned table, `f` foreign table, `v` view,
    /// `m` materialized view, `S` sequence.
    pub kind: String,
    pub row_estimate: Option<i64>,
    pub comment: Option<String>,
    /// `hypertable` or `cagg` on a database with TimescaleDB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timescale: Option<String>,
    /// A hypertable's or cagg's size on disk, its chunks included: the
    /// parent table itself is empty, so its row estimate says nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionEntry {
    pub name: String,
    /// The identity arguments, e.g. `order_id bigint`.
    pub args: String,
    /// `f` function, `p` procedure, `a` aggregate, `w` window.
    pub kind: String,
    pub returns: Option<String>,
    pub oid: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeEntry {
    pub name: String,
    /// `e` enum, `c` composite, `d` domain, `r` range.
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObjects {
    pub tables: Vec<RelationEntry>,
    pub views: Vec<RelationEntry>,
    pub materialized_views: Vec<RelationEntry>,
    /// TimescaleDB continuous aggregates: views to the catalog, moved out
    /// of `views`.
    #[serde(default)]
    pub continuous_aggregates: Vec<RelationEntry>,
    pub sequences: Vec<RelationEntry>,
    pub functions: Vec<FunctionEntry>,
    pub types: Vec<TypeEntry>,
}

/// A catalog read with whether TimescaleDB is installed, asked in the same
/// statement: these run on every expand and table open, and a separate
/// probe would cost a round trip each time on databases that never had it.
#[derive(Deserialize)]
struct WithTimescale<T> {
    #[serde(default)]
    timescale: bool,
    #[serde(flatten)]
    inner: T,
}

pub async fn list_schema_objects(client: &PgClient, schema: &str) -> AppResult<SchemaObjects> {
    let rel = |kinds: &str| {
        format!(
            "(SELECT coalesce(json_agg(json_build_object(
                'name', c.relname, 'kind', c.relkind,
                'rowEstimate', CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END,
                'comment', obj_description(c.oid, 'pg_class')) ORDER BY c.relname), '[]')
             FROM pg_class c
             WHERE c.relnamespace = n.oid AND c.relkind IN ({kinds}) AND NOT c.relispartition)"
        )
    };
    let not_extension = |catalog: &str, col: &str| {
        format!(
            "NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = '{catalog}'::regclass \
             AND dep.objid = {col} AND dep.deptype = 'e')"
        )
    };
    let sql = format!(
        "SELECT json_build_object(
            'timescale', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'),
            'tables', {tables},
            'views', {views},
            'materializedViews', {matviews},
            'sequences', {sequences},
            'functions', (SELECT coalesce(json_agg(json_build_object(
                    'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid),
                    'kind', p.prokind, 'returns', pg_get_function_result(p.oid), 'oid', p.oid::int8)
                    ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)), '[]')
                FROM pg_proc p WHERE p.pronamespace = n.oid AND {proc_ext}),
            'types', (SELECT coalesce(json_agg(json_build_object('name', t.typname, 'kind', t.typtype)
                    ORDER BY t.typname), '[]')
                FROM pg_type t
                WHERE t.typnamespace = n.oid
                  AND (t.typtype IN ('e', 'd', 'r')
                       OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
                  AND {type_ext})
         )
         FROM pg_namespace n WHERE n.nspname = {schema}",
        tables = rel("'r', 'p', 'f'"),
        views = rel("'v'"),
        matviews = rel("'m'"),
        sequences = rel("'S'"),
        proc_ext = not_extension("pg_proc", "p.oid"),
        type_ext = not_extension("pg_type", "t.oid"),
        schema = literal(schema),
    );
    let read: WithTimescale<SchemaObjects> = json_query(client, &sql)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("schema {schema}")))?;
    let mut objects = read.inner;
    if read.timescale {
        super::timescale::annotate_schema_objects(client, schema, &mut objects).await?;
    }
    Ok(objects)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub position: i32,
    /// As `format_type` writes it, e.g. `numeric(12,2)`, `order_status`.
    pub type_name: String,
    pub type_oid: i64,
    /// `pg_type.typcategory`: N numeric, S string, B boolean, D date/time,
    /// U user/json, A array, E enum...
    pub category: String,
    pub nullable: bool,
    pub default: Option<String>,
    /// `a` always / `d` by default, for identity columns.
    pub identity: Option<String>,
    /// `s` for stored generated columns.
    pub generated: Option<String>,
    pub comment: Option<String>,
    pub enum_values: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintInfo {
    pub name: String,
    /// `p` primary key, `u` unique, `f` foreign key, `c` check, `x` exclusion.
    pub kind: String,
    pub definition: String,
    pub columns: Option<Vec<String>>,
    pub ref_schema: Option<String>,
    pub ref_table: Option<String>,
    pub ref_columns: Option<Vec<String>>,
}

/// A foreign key elsewhere that points at this table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingKey {
    pub name: String,
    pub schema: String,
    pub table: String,
    /// The referencing table's columns.
    pub columns: Vec<String>,
    /// This table's columns they point at.
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub method: String,
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
    pub size_bytes: Option<i64>,
    pub scans: Option<i64>,
    pub columns: Vec<String>,
    /// The constraint the index backs, if any.
    pub constraint: Option<String>,
    /// `false` after a failed `CREATE INDEX CONCURRENTLY`: the planner
    /// ignores it and it only costs writes.
    #[serde(default = "yes")]
    pub valid: bool,
    /// A `WHERE` clause limits the rows it covers.
    #[serde(default)]
    pub partial: bool,
    /// The `WHERE` clause, for a partial index.
    #[serde(default)]
    pub predicate: Option<String>,
    /// Some key is an expression, not a column.
    #[serde(default)]
    pub expression: bool,
    /// Columns carried by `INCLUDE`, beyond the keys.
    #[serde(default)]
    pub include: Vec<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    pub definition: String,
    pub enabled: bool,
    /// `pg_trigger.tgenabled`: `O` on, `D` off, `R` on for replicas only,
    /// `A` always.
    #[serde(default)]
    pub enabled_state: String,
    /// `BEFORE`, `AFTER` or `INSTEAD OF`.
    #[serde(default)]
    pub timing: String,
    /// `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`.
    #[serde(default)]
    pub events: Vec<String>,
    /// `row` or `statement`.
    #[serde(default)]
    pub level: String,
    /// The function it runs, e.g. `audit.log_change()`.
    #[serde(default)]
    pub function: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStats {
    pub seq_scans: Option<i64>,
    pub idx_scans: Option<i64>,
    pub live_rows: Option<i64>,
    pub dead_rows: Option<i64>,
    pub last_vacuum: Option<String>,
    pub last_analyze: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub row_estimate: Option<i64>,
    pub size_bytes: Option<i64>,
    pub comment: Option<String>,
    pub columns: Vec<ColumnInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub referenced_by: Vec<IncomingKey>,
    pub indexes: Vec<IndexInfo>,
    pub triggers: Vec<TriggerInfo>,
    pub view_definition: Option<String>,
    pub stats: Option<TableStats>,
    /// The columns that identify a row for editing: the primary key, or a
    /// unique key over NOT NULL columns. Empty means read-only.
    #[serde(default)]
    pub row_key: Vec<String>,
    #[serde(default)]
    pub ddl: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hypertable: Option<super::timescale::HypertableSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cagg: Option<super::timescale::CaggSummary>,
    /// Set when the relation is a chunk of a hypertable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk: Option<super::timescale::ChunkParent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramColumn {
    pub name: String,
    /// As `format_type` writes it, e.g. `timestamp with time zone`.
    #[serde(rename = "type")]
    pub data_type: String,
    pub not_null: bool,
    /// Part of the primary key.
    pub pk: bool,
    /// Part of a foreign key.
    pub fk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramTable {
    pub name: String,
    pub kind: String,
    pub row_estimate: Option<i64>,
    pub columns: Vec<DiagramColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagramForeignKey {
    pub name: String,
    pub table: String,
    pub columns: Vec<String>,
    /// May be another schema: the diagram then shows it as a stub.
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiagram {
    pub tables: Vec<DiagramTable>,
    pub foreign_keys: Vec<DiagramForeignKey>,
}

/// The tables of a schema with their columns and keys, and the foreign keys
/// leaving them, in one round trip: what the schema diagram draws.
/// Partitions are left out (their parent stands for them).
pub async fn schema_diagram(client: &PgClient, schema: &str) -> AppResult<SchemaDiagram> {
    let cols_of = |keys: &str, rel: &str| {
        format!(
            "(SELECT json_agg(a.attname ORDER BY k.o) FROM unnest({keys}) WITH ORDINALITY k(n, o)
              JOIN pg_attribute a ON a.attrelid = {rel} AND a.attnum = k.n)"
        )
    };
    let sql = format!(
        "SELECT json_build_object(
            'tables', (SELECT coalesce(json_agg(json_build_object(
                    'name', c.relname, 'kind', c.relkind,
                    'rowEstimate', CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END,
                    'columns', (SELECT coalesce(json_agg(json_build_object(
                            'name', a.attname,
                            'type', format_type(a.atttypid, a.atttypmod),
                            'notNull', a.attnotnull,
                            'pk', EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid
                                          AND k.contype = 'p' AND a.attnum = ANY (k.conkey)),
                            'fk', EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid
                                          AND k.contype = 'f' AND a.attnum = ANY (k.conkey)))
                            ORDER BY a.attnum), '[]')
                        FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped))
                    ORDER BY c.relname), '[]')
                FROM pg_class c
                WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'f') AND NOT c.relispartition),
            'foreignKeys', (SELECT coalesce(json_agg(json_build_object(
                    'name', con.conname, 'table', c.relname, 'columns', {cols},
                    'refSchema', rn.nspname, 'refTable', rc.relname, 'refColumns', {ref_cols})
                    ORDER BY c.relname, con.conname), '[]')
                FROM pg_constraint con
                JOIN pg_class c ON c.oid = con.conrelid
                JOIN pg_class rc ON rc.oid = con.confrelid
                JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                WHERE con.contype = 'f' AND c.relnamespace = n.oid AND NOT c.relispartition
                  AND con.conparentid = 0)
         )
         FROM pg_namespace n WHERE n.nspname = {schema}",
        cols = cols_of("con.conkey", "con.conrelid"),
        ref_cols = cols_of("con.confkey", "con.confrelid"),
        schema = literal(schema),
    );
    json_query(client, &sql)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("schema {schema}")))
}

pub async fn describe_table(client: &PgClient, schema: &str, table: &str) -> AppResult<TableInfo> {
    let cols_of = |keys: &str, rel: &str| {
        format!(
            "(SELECT json_agg(a.attname ORDER BY k.o) FROM unnest({keys}) WITH ORDINALITY k(n, o)
              JOIN pg_attribute a ON a.attrelid = {rel} AND a.attnum = k.n)"
        )
    };
    let sql = format!(
        "WITH t AS (
            SELECT c.oid, c.relkind, c.reltuples, c.relname, n.nspname
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = {schema} AND c.relname = {table}
         )
         SELECT json_build_object(
            'timescale', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'),
            'schema', t.nspname, 'name', t.relname, 'kind', t.relkind,
            'rowEstimate', CASE WHEN t.reltuples < 0 THEN NULL ELSE t.reltuples::bigint END,
            'sizeBytes', pg_total_relation_size(t.oid),
            'comment', obj_description(t.oid, 'pg_class'),
            'columns', (SELECT coalesce(json_agg(json_build_object(
                    'name', a.attname, 'position', a.attnum,
                    'typeName', format_type(a.atttypid, a.atttypmod), 'typeOid', a.atttypid::int8,
                    'category', ty.typcategory, 'nullable', NOT a.attnotnull,
                    'default', CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END,
                    'identity', nullif(a.attidentity, ''),
                    'generated', CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END,
                    'comment', col_description(a.attrelid, a.attnum),
                    'enumValues', CASE WHEN ty.typtype = 'e' THEN
                        (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = ty.oid) END
                ) ORDER BY a.attnum), '[]')
                FROM pg_attribute a
                JOIN pg_type ty ON ty.oid = a.atttypid
                LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped),
            'constraints', (SELECT coalesce(json_agg(json_build_object(
                    'name', con.conname, 'kind', con.contype,
                    'definition', pg_get_constraintdef(con.oid, true),
                    'columns', {con_cols},
                    'refSchema', rn.nspname, 'refTable', rc.relname,
                    'refColumns', {con_ref_cols}
                ) ORDER BY con.contype, con.conname), '[]')
                FROM pg_constraint con
                LEFT JOIN pg_class rc ON rc.oid = con.confrelid
                LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                WHERE con.conrelid = t.oid AND con.contype <> 'n'),
            'referencedBy', (SELECT coalesce(json_agg(json_build_object(
                    'name', con.conname, 'schema', sn.nspname, 'table', sc.relname,
                    'columns', {in_cols}, 'refColumns', {in_ref_cols}
                ) ORDER BY sn.nspname, sc.relname, con.conname), '[]')
                FROM pg_constraint con
                JOIN pg_class sc ON sc.oid = con.conrelid
                JOIN pg_namespace sn ON sn.oid = sc.relnamespace
                WHERE con.confrelid = t.oid AND con.contype = 'f'),
            'indexes', (SELECT coalesce(json_agg(json_build_object(
                    'name', ic.relname, 'method', am.amname,
                    'definition', pg_get_indexdef(i.indexrelid),
                    'unique', i.indisunique, 'primary', i.indisprimary,
                    'sizeBytes', pg_relation_size(i.indexrelid), 'scans', s.idx_scan,
                    'columns', (SELECT json_agg(pg_get_indexdef(i.indexrelid, k, true) ORDER BY k)
                                FROM generate_series(1, i.indnkeyatts) k),
                    'constraint', (SELECT pc.conname FROM pg_constraint pc
                                   WHERE pc.conindid = i.indexrelid AND pc.conrelid = t.oid LIMIT 1),
                    'valid', i.indisvalid,
                    'partial', i.indpred IS NOT NULL,
                    'predicate', pg_get_expr(i.indpred, i.indrelid, true),
                    'expression', i.indexprs IS NOT NULL,
                    'include', (SELECT coalesce(json_agg(pg_get_indexdef(i.indexrelid, k, true) ORDER BY k), '[]')
                                FROM generate_series(i.indnkeyatts + 1, i.indnatts) k)
                ) ORDER BY i.indisprimary DESC, ic.relname), '[]')
                FROM pg_index i
                JOIN pg_class ic ON ic.oid = i.indexrelid
                JOIN pg_am am ON am.oid = ic.relam
                LEFT JOIN pg_stat_all_indexes s ON s.indexrelid = i.indexrelid
                WHERE i.indrelid = t.oid),
            'triggers', (SELECT coalesce(json_agg(json_build_object(
                    'name', tg.tgname, 'definition', pg_get_triggerdef(tg.oid, true),
                    'enabled', tg.tgenabled <> 'D', 'enabledState', tg.tgenabled::text,
                    'timing', CASE WHEN tg.tgtype & 64 <> 0 THEN 'INSTEAD OF'
                                   WHEN tg.tgtype & 2 <> 0 THEN 'BEFORE' ELSE 'AFTER' END,
                    'events', array_to_json(array_remove(ARRAY[
                        CASE WHEN tg.tgtype & 4 <> 0 THEN 'INSERT' END,
                        CASE WHEN tg.tgtype & 8 <> 0 THEN 'DELETE' END,
                        CASE WHEN tg.tgtype & 16 <> 0 THEN 'UPDATE' END,
                        CASE WHEN tg.tgtype & 32 <> 0 THEN 'TRUNCATE' END], NULL)),
                    'level', CASE WHEN tg.tgtype & 1 <> 0 THEN 'row' ELSE 'statement' END,
                    'function', tg.tgfoid::regprocedure::text) ORDER BY tg.tgname), '[]')
                FROM pg_trigger tg WHERE tg.tgrelid = t.oid AND NOT tg.tgisinternal),
            'viewDefinition', CASE WHEN t.relkind IN ('v', 'm') THEN pg_get_viewdef(t.oid, true) END,
            'stats', (SELECT json_build_object(
                    'seqScans', st.seq_scan, 'idxScans', st.idx_scan,
                    'liveRows', st.n_live_tup, 'deadRows', st.n_dead_tup,
                    'lastVacuum', greatest(st.last_vacuum, st.last_autovacuum),
                    'lastAnalyze', greatest(st.last_analyze, st.last_autoanalyze))
                FROM pg_stat_all_tables st WHERE st.relid = t.oid)
         ) FROM t",
        schema = literal(schema),
        table = literal(table),
        con_cols = cols_of("con.conkey", "con.conrelid"),
        con_ref_cols = cols_of("con.confkey", "con.confrelid"),
        in_cols = cols_of("con.conkey", "con.conrelid"),
        in_ref_cols = cols_of("con.confkey", "con.confrelid"),
    );
    let read: WithTimescale<TableInfo> = json_query(client, &sql)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("table {schema}.{table}")))?;
    let mut info = read.inner;
    info.row_key = row_key(&info);
    info.ddl = ddl(&info);
    if read.timescale {
        if let Some(ts) = super::timescale::probe(client).await? {
            super::timescale::annotate_table(client, &mut info, &ts).await?;
        }
    }
    Ok(info)
}

/// The primary key, else the first unique constraint whose columns are all
/// NOT NULL (a NULL in a unique column wouldn't identify one row).
pub fn row_key(info: &TableInfo) -> Vec<String> {
    if !matches!(info.kind.as_str(), "r" | "p") {
        return Vec::new();
    }
    let not_null = |c: &String| {
        info.columns
            .iter()
            .any(|col| &col.name == c && !col.nullable)
    };
    info.constraints
        .iter()
        .filter(|c| c.kind == "p")
        .chain(info.constraints.iter().filter(|c| c.kind == "u"))
        .filter_map(|c| c.columns.clone())
        .find(|cols| !cols.is_empty() && cols.iter().all(not_null))
        .unwrap_or_default()
}

/// A `CREATE` script for the relation, close to what `pg_dump` writes.
pub fn ddl(info: &TableInfo) -> String {
    let name = qualified(&info.schema, &info.name);
    let mut out = String::new();
    match info.kind.as_str() {
        "v" | "m" => {
            let kind = if info.kind == "m" {
                "MATERIALIZED VIEW"
            } else {
                "VIEW"
            };
            out.push_str(&format!(
                "CREATE {kind} {name} AS\n{};\n",
                info.view_definition
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .trim_end_matches(';')
            ));
        }
        _ => {
            let width = info
                .columns
                .iter()
                .map(|c| super::ident(&c.name).len())
                .max()
                .unwrap_or(0);
            let mut lines: Vec<String> = info
                .columns
                .iter()
                .map(|c| {
                    let mut line = format!("  {:width$} {}", super::ident(&c.name), c.type_name);
                    match (
                        c.identity.as_deref(),
                        c.generated.as_deref(),
                        c.default.as_deref(),
                    ) {
                        (Some("a"), _, _) => line.push_str(" GENERATED ALWAYS AS IDENTITY"),
                        (Some("d"), _, _) => line.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
                        (_, Some(expr), _) => {
                            line.push_str(&format!(" GENERATED ALWAYS AS ({expr}) STORED"))
                        }
                        (_, _, Some(default)) => line.push_str(&format!(" DEFAULT {default}")),
                        _ => {}
                    }
                    if !c.nullable {
                        line.push_str(" NOT NULL");
                    }
                    line
                })
                .collect();
            for con in &info.constraints {
                lines.push(format!(
                    "  CONSTRAINT {} {}",
                    super::ident(&con.name),
                    con.definition
                ));
            }
            out.push_str(&format!(
                "CREATE TABLE {name} (\n{}\n);\n",
                lines.join(",\n")
            ));
        }
    }
    let standalone: Vec<&IndexInfo> = info
        .indexes
        .iter()
        .filter(|i| i.constraint.is_none())
        .collect();
    if !standalone.is_empty() {
        out.push('\n');
        for index in standalone {
            out.push_str(&format!("{};\n", index.definition));
        }
    }
    if !info.triggers.is_empty() {
        out.push('\n');
        for trigger in &info.triggers {
            out.push_str(&format!("{};\n", trigger.definition));
        }
    }
    let mut comments = Vec::new();
    if let Some(comment) = &info.comment {
        let what = match info.kind.as_str() {
            "v" => "VIEW",
            "m" => "MATERIALIZED VIEW",
            _ => "TABLE",
        };
        comments.push(format!(
            "COMMENT ON {what} {name} IS {};",
            sql_string(comment)
        ));
    }
    for c in &info.columns {
        if let Some(comment) = &c.comment {
            comments.push(format!(
                "COMMENT ON COLUMN {name}.{} IS {};",
                super::ident(&c.name),
                sql_string(comment)
            ));
        }
    }
    if !comments.is_empty() {
        out.push('\n');
        out.push_str(&comments.join("\n"));
        out.push('\n');
    }
    out
}

/// A plain `'...'` literal, for scripts meant to be read and copied.
fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// The source of a view, function, sequence or type, for the explorer's
/// "Show definition".
pub async fn object_definition(
    client: &PgClient,
    schema: &str,
    name: &str,
    kind: &str,
    function_oid: Option<i64>,
) -> AppResult<String> {
    let sql = match kind {
        "function" => {
            let oid = function_oid.ok_or_else(|| AppError::InvalidInput("function oid missing".to_string()))?;
            format!(
                "SELECT to_json(CASE WHEN p.prokind = 'a' THEN
                    '-- aggregate ' || p.oid::regprocedure::text
                 ELSE pg_get_functiondef(p.oid) END)
                 FROM pg_proc p WHERE p.oid = {oid}"
            )
        }
        "sequence" => format!(
            "SELECT to_json(format('CREATE SEQUENCE %s AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s;',
                {q}, format_type(s.seqtypid, NULL), s.seqincrement, s.seqmin, s.seqmax, s.seqstart, s.seqcache,
                CASE WHEN s.seqcycle THEN ' CYCLE' ELSE '' END))
             FROM pg_sequence s WHERE s.seqrelid = {regclass}::regclass",
            q = literal(&qualified(schema, name)),
            regclass = literal(&qualified(schema, name)),
        ),
        "type" => format!(
            "SELECT to_json(CASE t.typtype
                WHEN 'e' THEN format('CREATE TYPE %s AS ENUM (%s);', t.oid::regtype,
                    (SELECT string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = t.oid))
                WHEN 'd' THEN format('CREATE DOMAIN %s AS %s%s%s;', t.oid::regtype, format_type(t.typbasetype, t.typtypmod),
                    CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END,
                    coalesce((SELECT string_agg(' CONSTRAINT ' || quote_ident(conname) || ' ' || pg_get_constraintdef(oid), '')
                              FROM pg_constraint WHERE contypid = t.oid), ''))
                WHEN 'c' THEN format('CREATE TYPE %s AS (%s);', t.oid::regtype,
                    (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
                     FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped))
                WHEN 'r' THEN format('CREATE TYPE %s AS RANGE (subtype = %s);', t.oid::regtype,
                    (SELECT format_type(rngsubtype, NULL) FROM pg_range WHERE rngtypid = t.oid))
                END)
             FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = {schema} AND t.typname = {name}",
            schema = literal(schema),
            name = literal(name),
        ),
        _ => {
            return describe_table(client, schema, name).await.map(|t| t.ddl);
        }
    };
    json_query::<String>(client, &sql)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("{kind} {schema}.{name}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, nullable: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            position: 1,
            type_name: "int8".to_string(),
            type_oid: 20,
            category: "N".to_string(),
            nullable,
            default: None,
            identity: None,
            generated: None,
            comment: None,
            enum_values: None,
        }
    }

    fn constraint(kind: &str, cols: &[&str]) -> ConstraintInfo {
        ConstraintInfo {
            name: format!("c_{kind}"),
            kind: kind.to_string(),
            definition: String::new(),
            columns: Some(cols.iter().map(|c| c.to_string()).collect()),
            ref_schema: None,
            ref_table: None,
            ref_columns: None,
        }
    }

    fn table(columns: Vec<ColumnInfo>, constraints: Vec<ConstraintInfo>) -> TableInfo {
        TableInfo {
            schema: "public".to_string(),
            name: "t".to_string(),
            kind: "r".to_string(),
            row_estimate: None,
            size_bytes: None,
            comment: None,
            columns,
            constraints,
            referenced_by: vec![],
            indexes: vec![],
            triggers: vec![],
            view_definition: None,
            stats: None,
            row_key: vec![],
            ddl: String::new(),
            hypertable: None,
            cagg: None,
            chunk: None,
        }
    }

    #[test]
    fn the_row_key_prefers_the_primary_key() {
        let t = table(
            vec![column("id", false), column("code", false)],
            vec![constraint("u", &["code"]), constraint("p", &["id"])],
        );
        assert_eq!(row_key(&t), ["id"]);
    }

    #[test]
    fn a_unique_key_with_nullable_columns_does_not_identify_rows() {
        let t = table(
            vec![column("email", true)],
            vec![constraint("u", &["email"])],
        );
        assert!(row_key(&t).is_empty());
        let t = table(
            vec![column("email", false)],
            vec![constraint("u", &["email"])],
        );
        assert_eq!(row_key(&t), ["email"]);
    }

    #[test]
    fn views_have_no_row_key() {
        let mut t = table(vec![column("id", false)], vec![constraint("p", &["id"])]);
        t.kind = "v".to_string();
        assert!(row_key(&t).is_empty());
    }

    #[test]
    fn ddl_lists_columns_and_constraints() {
        let mut id = column("id", false);
        id.identity = Some("d".to_string());
        let mut note = column("note", true);
        note.type_name = "text".to_string();
        note.comment = Some("it's free".to_string());
        let mut c = constraint("p", &["id"]);
        c.name = "t_pkey".to_string();
        c.definition = "PRIMARY KEY (id)".to_string();
        let sql = ddl(&table(vec![id, note], vec![c]));
        assert!(
            sql.contains("\"id\"   int8 GENERATED BY DEFAULT AS IDENTITY NOT NULL"),
            "{sql}"
        );
        assert!(
            sql.contains("CONSTRAINT \"t_pkey\" PRIMARY KEY (id)"),
            "{sql}"
        );
        assert!(
            sql.contains("COMMENT ON COLUMN \"public\".\"t\".\"note\" IS 'it''s free';"),
            "{sql}"
        );
    }
}
