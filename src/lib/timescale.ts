/**
 * TimescaleDB's public functions for completion, and how its intervals and
 * compression numbers read on screen. Signatures are TimescaleDB 2.18+'s;
 * procedures are called with CALL, the rest with SELECT.
 */

export const TIMESCALE_FUNCTIONS: { name: string; detail: string }[] = [
  { name: "time_bucket", detail: "time_bucket(bucket_width, ts [, origin | offset]) → same type as ts" },
  { name: "time_bucket_gapfill", detail: "time_bucket_gapfill(bucket_width, ts, start, finish) → bucket type; fill gaps with locf or interpolate" },
  { name: "locf", detail: "locf(value, prev [, treat_null_as_missing]) → same type; carries the last value forward" },
  { name: "interpolate", detail: "interpolate(value, prev, next) → same type; linear between the known points" },
  { name: "first", detail: "aggregate · first(value, time) → value type" },
  { name: "last", detail: "aggregate · last(value, time) → value type" },
  { name: "histogram", detail: "aggregate · histogram(value, min, max, nbuckets) → integer[]" },
  { name: "approximate_row_count", detail: "approximate_row_count(relation) → bigint" },
  { name: "show_chunks", detail: "show_chunks(hypertable [, older_than | newer_than]) → setof regclass" },
  { name: "drop_chunks", detail: "drop_chunks(hypertable, older_than | newer_than) → setof text; deletes data" },
  { name: "hypertable_size", detail: "hypertable_size(hypertable) → bigint" },
  { name: "hypertable_detailed_size", detail: "hypertable_detailed_size(hypertable) → table, index, toast and total bytes" },
  { name: "hypertable_approximate_size", detail: "hypertable_approximate_size(hypertable) → bigint" },
  { name: "hypertable_index_size", detail: "hypertable_index_size(index) → bigint" },
  { name: "chunks_detailed_size", detail: "chunks_detailed_size(hypertable) → one row per chunk with its bytes" },
  { name: "create_hypertable", detail: "create_hypertable(relation, dimension [, migrate_data => true]) → hypertable_id, created" },
  { name: "by_range", detail: "by_range(column, chunk_interval) → dimension for create_hypertable" },
  { name: "by_hash", detail: "by_hash(column, number_partitions) → dimension for create_hypertable or add_dimension" },
  { name: "add_dimension", detail: "add_dimension(hypertable, dimension [, if_not_exists]) → dimension_id, created" },
  { name: "set_chunk_time_interval", detail: "set_chunk_time_interval(hypertable, chunk_time_interval) → void" },
  { name: "add_retention_policy", detail: "add_retention_policy(relation, drop_after) → job_id" },
  { name: "remove_retention_policy", detail: "remove_retention_policy(relation [, if_exists]) → void" },
  { name: "add_columnstore_policy", detail: "procedure · CALL add_columnstore_policy(hypertable, after)" },
  { name: "remove_columnstore_policy", detail: "procedure · CALL remove_columnstore_policy(hypertable [, if_exists])" },
  { name: "convert_to_columnstore", detail: "procedure · CALL convert_to_columnstore(chunk [, if_not_columnstore, recompress])" },
  { name: "convert_to_rowstore", detail: "procedure · CALL convert_to_rowstore(chunk [, if_columnstore])" },
  { name: "hypertable_columnstore_stats", detail: "hypertable_columnstore_stats(hypertable) → chunk counts and before/after bytes" },
  { name: "chunk_columnstore_stats", detail: "chunk_columnstore_stats(hypertable) → one row per chunk with its before/after bytes" },
  { name: "add_continuous_aggregate_policy", detail: "add_continuous_aggregate_policy(cagg, start_offset, end_offset, schedule_interval) → job_id" },
  { name: "remove_continuous_aggregate_policy", detail: "remove_continuous_aggregate_policy(cagg [, if_exists]) → void" },
  { name: "refresh_continuous_aggregate", detail: "procedure · CALL refresh_continuous_aggregate(cagg, window_start, window_end)" },
  { name: "add_job", detail: "add_job(proc, schedule_interval [, config]) → job_id" },
  { name: "alter_job", detail: "alter_job(job_id [, schedule_interval, config, scheduled, ...]) → job row" },
  { name: "delete_job", detail: "delete_job(job_id) → void" },
  { name: "run_job", detail: "procedure · CALL run_job(job_id)" },
  { name: "timescaledb_pre_restore", detail: "timescaledb_pre_restore() → void; call before pg_restore of a database with TimescaleDB" },
  { name: "timescaledb_post_restore", detail: "timescaledb_post_restore() → void; call after pg_restore, pairs with the pre_restore call" },
];

// ------------------------------------------------------------ intervals

/** Units from most to least significant, with the label they print as. */
const UNIT_LABELS = { y: "y", mo: "mo", w: "w", d: "d", h: "h", min: "min", s: "s" } as const;
type Unit = keyof typeof UNIT_LABELS;
const ORDER = Object.keys(UNIT_LABELS) as Unit[];

/** A word unit as PostgreSQL prints it (`1 day`, `2 mons`) or as written (`1 hour`). */
function unitOf(word: string): Unit | null {
  const w = word.toLowerCase();
  if (w.startsWith("year")) return "y";
  if (w.startsWith("mon")) return "mo";
  if (w.startsWith("week")) return "w";
  if (w.startsWith("day")) return "d";
  if (w.startsWith("hour") || w === "hr" || w === "hrs") return "h";
  if (w.startsWith("min")) return "min";
  if (w.startsWith("sec") || w === "s") return "s";
  return null;
}

const WORD_PART = /([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]+)\b/g;
const CLOCK_PART = /([+-]?)(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/;

/**
 * An interval in a short form: the two most significant units that aren't
 * zero, so `1 day 02:01:00` reads `1 d 2 h` and `02:01:13.5` reads `2 h 1 min`.
 * Input that doesn't parse is returned as it was given.
 */
export function shortInterval(text: string | null | undefined): string {
  if (!text) return "";
  const raw = text.trim();
  if (!raw) return "";

  const totals: Partial<Record<Unit, number>> = {};
  const add = (unit: Unit, value: number) => {
    totals[unit] = (totals[unit] ?? 0) + value;
  };

  let rest = raw;
  const clock = CLOCK_PART.exec(raw);
  if (clock) {
    const sign = clock[1] === "-" ? -1 : 1;
    add("h", sign * Number(clock[2]));
    add("min", sign * Number(clock[3]));
    add("s", sign * Number(clock[4]));
    rest = raw.replace(CLOCK_PART, " ");
  }

  let parsed = clock !== null;
  for (const m of rest.matchAll(WORD_PART)) {
    const unit = unitOf(m[2]);
    if (!unit) return raw;
    add(unit, Number(m[1]));
    parsed = true;
  }
  if (!parsed) return raw;

  const units = ORDER.filter((u) => (totals[u] ?? 0) !== 0).slice(0, 2);
  // a lag like 00:39:14.2 reads as "39 min 14 s": fractions only on their own
  const parts = units.map((u) => {
    const value = totals[u] as number;
    return `${u === "s" && units.length > 1 ? Math.round(value) : Number(value.toFixed(2))} ${UNIT_LABELS[u]}`;
  });
  return parts.length ? parts.join(" ") : "0 s";
}

// ------------------------------------------------------------ compression

/** before / after, or null when either size is unknown or the after size is 0. */
export function compressionRatio(before: number | null, after: number | null): number | null {
  if (before === null || after === null || after === 0) return null;
  return before / after;
}

/** `6.2×`, one decimal. */
export function formatRatio(r: number): string {
  return `${r.toFixed(1)}×`;
}
