import { Database } from "lucide-react";
import { useConnectionsStore } from "../../store/connectionsStore";
import { databaseKey, schemaKey, useExplorerStore } from "../../store/explorerStore";
import { useDumpStore } from "../../store/dumpStore";
import { useObjectDialogsStore } from "../../store/objectDialogsStore";
import { useSessionsStore } from "../../store/sessionsStore";
import { openRunSqlFile } from "../../store/transferStore";
import type { TabConnection } from "../../store/sessionsStore";
import type { DatabaseInfo } from "../../types/pg";
import { RowContextMenu } from "@/components/common/ActionMenu";
import { formatBytes } from "@/lib/format";
import { useGraphStore } from "../../store/graphStore";
import { GraphRows } from "./GraphRows";
import { ExtensionsGroup } from "../objects/ExtensionsGroup";
import { SchemaRow } from "./SchemaRow";
import { TreeNote } from "./TreeNote";
import { TreeRow } from "./TreeRow";
import { databaseMenuEntries } from "./treeMenus";
import { schemaMatches } from "./useTableMatches";

interface DatabaseRowProps {
  db: DatabaseInfo;
  sessionId: string;
  connection: TabConnection;
  depth: number;
  /** The sidebar search, lowercased. */
  query: string;
}

/** A database of a connection; opens to its schemas. */
export function DatabaseRow({ db, sessionId, connection, depth, query }: DatabaseRowProps) {
  const node = useExplorerStore((s) => s.databases[databaseKey(connection.id, db.name)]);
  const schemaNodes = useExplorerStore((s) => s.schemas);
  const toggle = useExplorerStore((s) => s.toggleDatabase);
  const refresh = useExplorerStore((s) => s.refreshDatabase);
  const showSystem = useConnectionsStore((s) => s.sessions[connection.id]?.showSystemSchemas ?? false);
  const isDefault = useConnectionsStore((s) => s.sessions[connection.id]?.defaultDatabase === db.name);
  const openConsole = useSessionsStore((s) => s.openConsole);

  const schemas = (node?.schemas ?? []).filter((s) => showSystem || !s.system);
  // A search opens the databases with hits and narrows them to those.
  const hits = query
    ? schemas.filter((s) => {
        const objects = schemaNodes[schemaKey(connection.id, db.name, s.name)]?.objects ?? null;
        return s.name.toLowerCase().includes(query) || schemaMatches(objects, query);
      })
    : schemas;
  const searching = query !== "" && hits.length > 0;
  const isOpen = (node?.expanded ?? false) || searching;

  return (
    <>
      <RowContextMenu
        entries={() =>
          databaseMenuEntries({
            database: db.name,
            connectionName: connection.name,
            onOpenConsole: () => openConsole(connection, db.name),
            onBackup: () => useDumpStore.getState().open("backup", connection, db.name),
            onRestore: () => useDumpStore.getState().open("restore", connection, db.name),
            onActivity: () => useSessionsStore.getState().openActivity(connection, db.name),
            onExtensions: () => useObjectDialogsStore.getState().openExtensions({ connection, sessionId, database: db.name }),
            onRunFile: () => openRunSqlFile(connection, db.name),
            onRefresh: () => {
              void refresh(connection.id, sessionId, db.name);
              void useGraphStore.getState().refresh(connection.id, sessionId, db.name);
              void useConnectionsStore.getState().refreshDatabases(connection.id);
            },
          })
        }
      >
        <TreeRow
          depth={depth}
          expanded={isOpen}
          title={db.comment ?? db.name}
          icon={<Database className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
          label={db.name}
          labelClassName={isDefault ? "font-medium" : undefined}
          trailing={db.sizeBytes !== null && <span>{formatBytes(db.sizeBytes)}</span>}
          onActivate={() => void toggle(connection.id, sessionId, db.name)}
        />
      </RowContextMenu>
      {isOpen && (
        <div role="group">
          {node?.error ? (
            <TreeNote depth={depth + 1} tone="danger">
              {node.error}
            </TreeNote>
          ) : node?.loading && !node.loaded ? (
            <TreeNote depth={depth + 1}>Loading…</TreeNote>
          ) : (
            node?.loaded && schemas.length === 0 && <TreeNote depth={depth + 1}>No schemas</TreeNote>
          )}
          {(query ? hits : schemas).map((schema) => (
            <SchemaRow
              key={schema.name}
              schema={schema}
              database={db.name}
              sessionId={sessionId}
              connection={connection}
              depth={depth + 1}
              query={query}
            />
          ))}
          <GraphRows database={db.name} sessionId={sessionId} connection={connection} depth={depth + 1} active={isOpen} query={query} />
          {!query && node?.loaded && (
            <ExtensionsGroup database={db.name} sessionId={sessionId} connection={connection} depth={depth + 1} />
          )}
        </div>
      )}
    </>
  );
}
