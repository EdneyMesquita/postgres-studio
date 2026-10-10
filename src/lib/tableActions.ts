import type { MaintenanceAction } from "../types/objects";
import type { RelKind } from "../types/pg";

/** What the "Generate SQL" submenu offers. */
export type GenerateKind = "select" | "insert" | "update" | "delete" | "ddl";

export const MAINTENANCE_LABEL: Record<MaintenanceAction, string> = {
  vacuumAnalyze: "VACUUM (ANALYZE)",
  analyze: "ANALYZE",
  reindex: "REINDEX TABLE",
  truncate: "TRUNCATE…",
};

export const GENERATE_LABEL: Record<GenerateKind, string> = {
  select: "SELECT with all columns",
  insert: "INSERT template",
  update: "UPDATE by primary key",
  delete: "DELETE by primary key",
  ddl: "The table's DDL",
};

/** The maintenance Postgres accepts on a relation of this kind. */
export function maintenanceFor(kind: RelKind): MaintenanceAction[] {
  switch (kind) {
    case "r":
    case "p":
      return ["vacuumAnalyze", "analyze", "reindex", "truncate"];
    case "m":
      return ["vacuumAnalyze", "analyze", "reindex"];
    case "f":
      return ["analyze"];
    default:
      return [];
  }
}

/** The SQL that can be generated for a relation of this kind. */
export function generatableFor(kind: RelKind): GenerateKind[] {
  switch (kind) {
    case "r":
    case "p":
    case "f":
      return ["select", "insert", "update", "delete", "ddl"];
    case "v":
    case "m":
      return ["select", "ddl"];
    default:
      return [];
  }
}
