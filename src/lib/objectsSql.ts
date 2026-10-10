import type { ColumnInfo, IndexInfo, TableInfo } from "../types/pg";

// Generators for the SQL the object actions open in a console. Nothing here
// runs a statement; the text is for reading, editing and running by hand.

/** Words that can't stand as a bare table or column name. */
const RESERVED = new Set(
  (
    "all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create " +
    "current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc " +
    "distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral " +
    "leading limit localtime localtimestamp not null offset on only or order placing primary references returning " +
    "select session_user some symmetric system_user table then to trailing true union unique user using variadic " +
    "when where window with authorization binary collation concurrently cross current_schema freeze full ilike inner " +
    "is isnull join left like natural notnull outer overlaps right similar tablesample verbose"
  ).split(" "),
);

/** `name`, double-quoted unless it is a plain lowercase word that is no keyword. */
export function quote(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** `schema.name`, each part quoted as needed. */
export function qualify(schema: string, name: string): string {
  return `${quote(schema)}.${quote(name)}`;
}

/** A `'...'` string literal. */
export function stringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ---- triggers ----

export function toggleTriggerSql(schema: string, table: string, trigger: string, enable: boolean): string {
  return `ALTER TABLE ${qualify(schema, table)} ${enable ? "ENABLE" : "DISABLE"} TRIGGER ${quote(trigger)};\n`;
}

export function dropTriggerSql(schema: string, table: string, trigger: string): string {
  return `DROP TRIGGER ${quote(trigger)} ON ${qualify(schema, table)};\n`;
}

// ---- indexes ----

export function reindexIndexSql(schema: string, index: string): string {
  return `-- CONCURRENTLY can't run inside a transaction block.\nREINDEX INDEX CONCURRENTLY ${qualify(schema, index)};\n`;
}

/** An index behind a constraint goes with `DROP CONSTRAINT`; a plain one with `DROP INDEX`. */
export function dropIndexSql(schema: string, table: string, index: Pick<IndexInfo, "name" | "constraint">): string {
  if (index.constraint) {
    return `-- ${quote(index.name)} backs a constraint, which has to go instead of the index.\nALTER TABLE ${qualify(schema, table)} DROP CONSTRAINT ${quote(index.constraint)};\n`;
  }
  return `-- CONCURRENTLY can't run inside a transaction block.\nDROP INDEX CONCURRENTLY IF EXISTS ${qualify(schema, index.name)};\n`;
}

export const INDEX_METHODS = ["btree", "hash", "gin", "gist", "brin"] as const;
export type IndexMethod = (typeof INDEX_METHODS)[number];

/** Postgres cuts identifiers at 63 bytes. */
const MAX_IDENT = 63;

/** `table_col1_col2_idx`, kept within the identifier limit. */
export function defaultIndexName(table: string, columns: string[]): string {
  const suffix = "_idx";
  const base = [table, ...columns].join("_").replace(/[^A-Za-z0-9_$]+/g, "_");
  return base.slice(0, MAX_IDENT - suffix.length) + suffix;
}

export interface NewIndex {
  schema: string;
  table: string;
  name: string;
  method: IndexMethod;
  columns: string[];
  unique?: boolean;
}

/** `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, with a note on why it can't sit in a transaction. */
export function newIndexSql(i: NewIndex): string {
  const cols = i.columns.map(quote).join(", ");
  return (
    "-- CONCURRENTLY builds the index without blocking writes, and can't run inside a transaction block.\n" +
    `CREATE ${i.unique ? "UNIQUE " : ""}INDEX CONCURRENTLY IF NOT EXISTS ${quote(i.name)}\n` +
    `  ON ${qualify(i.schema, i.table)} USING ${i.method} (${cols});\n`
  );
}

// ---- materialized views ----

/** Whether `REFRESH ... CONCURRENTLY` works: it needs a unique index over plain columns, not partial. */
export function canRefreshConcurrently(indexes: Pick<IndexInfo, "unique" | "valid" | "partial" | "expression">[]): boolean {
  return indexes.some((i) => i.unique && i.valid && !i.partial && !i.expression);
}

export function refreshMatviewSql(schema: string, name: string, indexes: Parameters<typeof canRefreshConcurrently>[0]): string {
  const target = qualify(schema, name);
  if (canRefreshConcurrently(indexes)) {
    return `-- CONCURRENTLY keeps the view readable while it refreshes (it has a unique index, and has to be populated already).\nREFRESH MATERIALIZED VIEW CONCURRENTLY ${target};\n`;
  }
  return `-- Locks the view against reads while it refreshes; a unique index over plain columns would allow CONCURRENTLY.\nREFRESH MATERIALIZED VIEW ${target};\n`;
}

// ---- templates for a table ----

type Described = Pick<TableInfo, "schema" | "name" | "columns" | "rowKey">;

/** Columns a statement can write: not generated, not always-identity. */
function writable(columns: ColumnInfo[]): ColumnInfo[] {
  return columns.filter((c) => !c.generated && c.identity !== "a");
}

export function selectAllSql(t: Described): string {
  const cols = t.columns.map((c) => `  ${quote(c.name)}`).join(",\n");
  return `SELECT\n${cols}\nFROM ${qualify(t.schema, t.name)}\nLIMIT 100;\n`;
}

export function insertTemplateSql(t: Described): string {
  const cols = writable(t.columns);
  const names = cols.map((c) => `  ${quote(c.name)}`).join(",\n");
  const values = cols
    .map((c, i) => `  ${c.default || c.identity ? "DEFAULT" : "NULL"}${i < cols.length - 1 ? "," : ""} -- ${c.typeName}${c.nullable ? "" : ", not null"}`)
    .join("\n");
  return `INSERT INTO ${qualify(t.schema, t.name)} (\n${names}\n)\nVALUES (\n${values}\n);\n`;
}

/** `key = NULL` placeholders: matches nothing until each NULL is replaced, so a stray run changes no row. */
function keyWhere(t: Described): string {
  if (t.rowKey.length === 0) return "false -- no primary key: write the condition that picks the rows";
  return t.rowKey.map((k) => `${quote(k)} = NULL`).join("\n  AND ");
}

export function updateTemplateSql(t: Described): string {
  const cols = writable(t.columns).filter((c) => !t.rowKey.includes(c.name));
  const sets = cols.map((c) => `  ${quote(c.name)} = ${quote(c.name)}`).join(",\n");
  return `-- Each NULL in the WHERE has to become the key of the row to change.\nUPDATE ${qualify(t.schema, t.name)}\nSET\n${sets}\nWHERE ${keyWhere(t)};\n`;
}

export function deleteTemplateSql(t: Described): string {
  return `-- Each NULL in the WHERE has to become the key of the row to delete.\nDELETE FROM ${qualify(t.schema, t.name)}\nWHERE ${keyWhere(t)};\n`;
}
