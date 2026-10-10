import { useMemo } from "react";
import { connectionColor } from "../../lib/connectionColor";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useExplorerStore } from "../../store/explorerStore";
import type { TabConnection } from "../../store/sessionsStore";
import type { RelKind } from "../../types/pg";
import type { Searchable } from "../../lib/paletteMatch";

export interface PaletteTable extends Searchable {
  /** Unique across connections: `<connectionId>/<database>/<schema>.<table>`. */
  key: string;
  connection: TabConnection;
  color: string;
  database: string;
  schema: string;
  table: string;
  kind: RelKind;
}

/**
 * Every table and view already listed in the Explorer for a connected
 * server: the schemas whose objects have been loaded. Nothing is fetched here.
 */
export function usePaletteTables(): PaletteTable[] {
  const schemas = useExplorerStore((s) => s.schemas);
  const sessions = useConnectionsStore((s) => s.sessions);
  const profiles = useConnectionsStore((s) => s.profiles);

  return useMemo(() => {
    const items: PaletteTable[] = [];
    for (const profile of profiles) {
      if (!sessions[profile.id]) continue;
      const connection = { id: profile.id, name: profile.name, summary: profile.summary };
      const color = connectionColor(profile.id, profile.color);
      const prefix = `${profile.id}/`;
      const where = profile.name.toLowerCase();
      for (const [key, node] of Object.entries(schemas)) {
        // keys are "<connectionId>/<database>/<schema>"
        if (!key.startsWith(prefix) || !node.objects) continue;
        const [database, ...rest] = key.slice(prefix.length).split("/");
        const schema = rest.join("/");
        const { tables, views, materializedViews } = node.objects;
        for (const rel of [...tables, ...views, ...materializedViews]) {
          // matched on every keystroke, so lowercased once here
          const label = (schema === "public" ? rel.name : `${schema}.${rel.name}`).toLowerCase();
          items.push({
            key: `${key}.${rel.name}`,
            connection,
            color,
            database,
            schema,
            table: rel.name,
            kind: rel.kind,
            label,
            haystack: `${label} ${database.toLowerCase()} ${where}`,
          });
        }
      }
    }
    return items;
  }, [schemas, sessions, profiles]);
}
