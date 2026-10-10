import type { ColumnInfo, ResultColumn } from "../types/pg";

/** How a column's values look: picks the syntax color and alignment. */
export type ValueKind = "number" | "bool" | "temporal" | "json" | "enum" | "uuid" | "bytes" | "array" | "text";

const NUMBER_OIDS = new Set([20, 21, 23, 26, 700, 701, 790, 1700]);
const TEMPORAL_OIDS = new Set([1082, 1083, 1114, 1184, 1186, 1266]);
const JSON_OIDS = new Set([114, 3802]);

/** The kind of a column, from its type OID, name and (when known) catalog category. */
export function valueKind(column: Pick<ResultColumn, "typeOid" | "typeName">, info?: Pick<ColumnInfo, "category" | "enumValues"> | null): ValueKind {
  const { typeOid, typeName } = column;
  if (info?.enumValues) return "enum";
  if (info?.category === "A" || typeName.endsWith("[]")) return "array";
  if (NUMBER_OIDS.has(typeOid) || /^(smallint|integer|bigint|numeric|real|double precision|money|int[248]|float[48])/.test(typeName)) return "number";
  if (typeOid === 16 || typeName === "boolean" || typeName === "bool") return "bool";
  if (TEMPORAL_OIDS.has(typeOid) || /^(date|time|timestamp|interval)/.test(typeName)) return "temporal";
  if (JSON_OIDS.has(typeOid) || typeName === "json" || typeName === "jsonb") return "json";
  if (typeOid === 2950 || typeName === "uuid") return "uuid";
  if (typeOid === 17 || typeName === "bytea") return "bytes";
  if (info?.category === "E") return "enum";
  return "text";
}

/** Text color per kind; plain strings stay in the body color (DESIGN.md). */
export function kindClass(kind: ValueKind): string {
  switch (kind) {
    case "number":
      return "text-json-number";
    case "bool":
    case "enum":
      return "text-json-keyword";
    case "temporal":
    case "uuid":
      return "text-json-bson";
    case "json":
    case "array":
    case "bytes":
      return "text-fg-2";
    default:
      return "text-fg";
  }
}

export function alignsRight(kind: ValueKind): boolean {
  return kind === "number";
}

/** A value as one grid line: newlines shown as ↵ and long text cut. */
export function cellText(value: string, max = 300): string {
  const flat = value.length > max ? `${value.slice(0, max)}…` : value;
  return flat.replace(/\r?\n/g, " ↵ ");
}

/** Booleans come back as t / f; shown spelled out. */
export function displayValue(kind: ValueKind, value: string): string {
  if (kind === "bool") return value === "t" ? "true" : value === "f" ? "false" : value;
  return value;
}

/** Pretty JSON for the inspector, or the text as is when it isn't JSON. */
export function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

/** What an edit field takes for a boolean: true/false/t/f/yes/no/1/0. */
export function normalizeBool(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (["t", "true", "yes", "y", "on", "1"].includes(v)) return "t";
  if (["f", "false", "no", "n", "off", "0"].includes(v)) return "f";
  return null;
}
