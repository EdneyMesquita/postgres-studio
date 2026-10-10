import { useMemo } from "react";
import { useExplorerStore } from "../../store/explorerStore";
import type { SchemaObjects } from "../../types/pg";

/** Whether any object listed in the schema has the search in its name. */
export function schemaMatches(objects: SchemaObjects | null, query: string): boolean {
  if (!objects || !query) return false;
  const lists = [
    objects.tables,
    objects.views,
    objects.materializedViews,
    objects.sequences,
    objects.functions,
    objects.types,
  ] as { name: string }[][];
  return lists.some((list) => list.some((o) => o.name.toLowerCase().includes(query)));
}

export interface TableHit {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  kind: "r" | "p" | "f" | "v" | "m" | "S";
}

/**
 * Connections with objects whose names contain the sidebar search, and the
 * first table or view found (where Enter in the search goes). Covers every
 * schema the explorer has listed; the others would cost a round trip each.
 */
export function useTableMatches(query: string): { connectionIds: Set<string>; first: TableHit | null } | null {
  const schemas = useExplorerStore((s) => s.schemas);
  return useMemo(() => {
    if (!query) return null;
    const connectionIds = new Set<string>();
    let first: TableHit | null = null;
    for (const [key, node] of Object.entries(schemas)) {
      if (!node.objects || !schemaMatches(node.objects, query)) continue;
      // keys are "<connection>/<database>/<schema>"; ids and databases hold no "/"
      const [connectionId, database, ...rest] = key.split("/");
      const schema = rest.join("/");
      connectionIds.add(connectionId);
      if (!first) {
        const rel = [...node.objects.tables, ...node.objects.views, ...node.objects.materializedViews].find((o) =>
          o.name.toLowerCase().includes(query),
        );
        if (rel) first = { connectionId, database, schema, table: rel.name, kind: rel.kind };
      }
    }
    return connectionIds.size > 0 ? { connectionIds, first } : null;
  }, [query, schemas]);
}
