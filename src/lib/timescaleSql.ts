import { qualify, quote, stringLiteral } from "./objectsSql";

// Generators for the TimescaleDB statements the console opens (2.18+ API). They
// return text for reading and running by hand; nothing here runs a statement.

/** A relation as the `'...'` regclass argument these functions take. */
function regclass(schema: string, name: string): string {
  return stringLiteral(qualify(schema, name));
}

function interval(text: string): string {
  return `INTERVAL ${stringLiteral(text)}`;
}

/** `create_hypertable` on a plain table; migrate_data also takes the rows that are already there. */
export function createHypertableSql(schema: string, table: string, timeColumn: string | null, chunkInterval = "7 days"): string {
  // by_range takes the column as a name, not as an identifier, so it is not quoted
  const column = timeColumn === null ? "<time column>" : timeColumn;
  const note =
    timeColumn === null
      ? "-- Replace <time column> with the timestamp column that partitions the table."
      : "-- migrate_data moves the rows already in the table into chunks and locks the table while it does.";
  return [
    note,
    `SELECT create_hypertable(${regclass(schema, table)}, by_range(${stringLiteral(column)}, ${interval(chunkInterval)}), migrate_data => true);`,
  ].join("\n");
}

export function retentionPolicySql(schema: string, table: string, dropAfter = "90 days"): string {
  return `SELECT add_retention_policy(${regclass(schema, table)}, drop_after => ${interval(dropAfter)});`;
}

/**
 * The columnstore settings and the policy. The policy can't be added until
 * the table has the columnstore on, so the ALTER always comes first; segmentby
 * and orderby are added to it only when given.
 */
export function columnstorePolicySql(
  schema: string,
  table: string,
  after = "7 days",
  segmentby: string[] = [],
  orderby: string[] = [],
): string {
  const settings = ["timescaledb.enable_columnstore = true"];
  if (segmentby.length) settings.push(`timescaledb.segmentby = ${stringLiteral(segmentby.map((c) => quote(c)).join(", "))}`);
  if (orderby.length) settings.push(`timescaledb.orderby = ${stringLiteral(orderby.map(orderItem).join(", "))}`);
  return [
    `ALTER TABLE ${qualify(schema, table)} SET (${settings.join(", ")});`,
    `CALL add_columnstore_policy(${regclass(schema, table)}, after => ${interval(after)});`,
  ].join("\n");
}

/** A column with an optional ASC/DESC and NULLS FIRST/LAST, the way orderby reads it. */
const DIRECTION = /\s+((?:asc|desc)(?:\s+nulls\s+(?:first|last))?)$/i;

function orderItem(entry: string): string {
  const text = entry.trim();
  const direction = DIRECTION.exec(text);
  if (!direction) return quote(text);
  return `${quote(text.slice(0, direction.index))} ${direction[1].toUpperCase()}`;
}

export function refreshPolicySql(schema: string, view: string, startOffset = "3 days", endOffset = "1 hour", schedule = "1 hour"): string {
  return [
    `SELECT add_continuous_aggregate_policy(${regclass(schema, view)},`,
    `  start_offset => ${interval(startOffset)}, end_offset => ${interval(endOffset)}, schedule_interval => ${interval(schedule)});`,
  ].join("\n");
}

export function removePolicySql(kind: "retention" | "columnstore" | "refresh", schema: string, name: string): string {
  const target = regclass(schema, name);
  switch (kind) {
    case "retention":
      return `SELECT remove_retention_policy(${target}, if_exists => true);`;
    case "columnstore":
      return `CALL remove_columnstore_policy(${target}, if_exists => true);`;
    case "refresh":
      return `SELECT remove_continuous_aggregate_policy(${target}, if_exists => true);`;
  }
}

/** Only the parts given change; with none, the statement reads the job and changes nothing. */
export function alterJobSql(jobId: number, changes: { scheduleInterval?: string; config?: Record<string, unknown> }): string {
  if (!Number.isSafeInteger(jobId)) throw new Error(`job id must be an integer, got ${jobId}`);
  const args = [`${jobId}`];
  if (changes.scheduleInterval !== undefined) args.push(`schedule_interval => ${interval(changes.scheduleInterval)}`);
  if (changes.config !== undefined) args.push(`config => ${stringLiteral(JSON.stringify(changes.config))}::jsonb`);
  return `SELECT alter_job(${args.join(", ")});`;
}

const BUCKET_WORDS: Record<string, string> = {
  "1 hour": "hourly",
  "1 day": "daily",
  "1 week": "weekly",
  "1 month": "monthly",
  "1 year": "yearly",
};

/**
 * A starting continuous aggregate: a count per bucket, created WITH NO DATA
 * so nothing is materialized until a refresh. The refresh policy follows as a
 * comment, since a policy the user didn't ask for would run on its own.
 */
export function createCaggSql(schema: string, table: string, timeColumn: string | null, bucket = "1 hour"): string {
  const word = BUCKET_WORDS[bucket] ?? "agg";
  const view = `${table}_${word}`;
  // the column is an identifier here, unlike in by_range; a placeholder stands in when the table has no time column
  const column = timeColumn === null ? "<time column>" : quote(timeColumn);
  const note =
    timeColumn === null
      ? "-- Replace <time column> with the table's timestamp column."
      : "-- A starting point: change the select list, then refresh it with the policy below.";
  const policy = refreshPolicySql(schema, view)
    .split("\n")
    .map((line) => `-- ${line}`)
    .join("\n");
  return [
    note,
    `CREATE MATERIALIZED VIEW ${qualify(schema, view)} WITH (timescaledb.continuous) AS`,
    `SELECT time_bucket(${interval(bucket)}, ${column}) AS bucket, count(*)`,
    `FROM ${qualify(schema, table)}`,
    "GROUP BY 1",
    "WITH NO DATA;",
    policy,
  ].join("\n");
}
