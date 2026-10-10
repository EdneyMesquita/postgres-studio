import { useRef } from "react";
import { Eye, Folder, FolderOpen, Layers, Layers2, ListOrdered, Sigma, Table, Type } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../lib/tauri";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useConsoleStore } from "../../store/consoleStore";
import { groupKey, groupOpen, schemaKey, useExplorerStore } from "../../store/explorerStore";
import type { ObjectGroup } from "../../store/explorerStore";
import { selectActiveTab, useSessionsStore } from "../../store/sessionsStore";
import type { TabConnection } from "../../store/sessionsStore";
import { openImportCsv } from "../../store/transferStore";
import { useUiStore } from "../../store/uiStore";
import type { FunctionEntry, RelationEntry, SchemaInfo, TypeEntry } from "../../types/pg";
import { RowContextMenu } from "@/components/common/ActionMenu";
import { formatCount } from "@/lib/format";
import { generateSql, runMaintenance } from "../objects/tableActions";
import { Highlighted } from "./Highlighted";
import { TreeNote } from "./TreeNote";
import { TreeRow } from "./TreeRow";
import { functionMenuEntries, relationMenuEntries, schemaMenuEntries, typeMenuEntries } from "./treeMenus";
import { useWindowedRows } from "./useWindowedRows";

interface SchemaRowProps {
  schema: SchemaInfo;
  database: string;
  sessionId: string;
  connection: TabConnection;
  depth: number;
  query: string;
}

const GROUPS: { id: ObjectGroup; label: string; icon: LucideIcon }[] = [
  { id: "tables", label: "Tables", icon: Table },
  { id: "views", label: "Views", icon: Eye },
  { id: "materializedViews", label: "Materialized views", icon: Layers2 },
  { id: "functions", label: "Functions", icon: Sigma },
  { id: "sequences", label: "Sequences", icon: ListOrdered },
  { id: "types", label: "Types", icon: Type },
];

/** Opens a definition in a new console, to read or edit and run. */
async function showDefinition(
  connection: TabConnection,
  sessionId: string,
  database: string,
  schema: string,
  name: string,
  kind: "table" | "function" | "sequence" | "type",
  oid: number | null = null,
) {
  try {
    const text = await api.objectDefinition(sessionId, database, schema, name, kind, oid);
    const id = useSessionsStore.getState().openConsole(connection, database);
    useConsoleStore.getState().setScript(id, text.endsWith("\n") ? text : `${text}\n`);
  } catch (e) {
    toast.error(`Couldn't read the definition of ${name}`, { description: String(e) });
  }
}

/** A schema: its object groups, each listing what it holds. */
export function SchemaRow({ schema, database, sessionId, connection, depth, query }: SchemaRowProps) {
  const key = schemaKey(connection.id, database, schema.name);
  const node = useExplorerStore((s) => s.schemas[key]);
  const groups = useExplorerStore((s) => s.groups);
  const toggle = useExplorerStore((s) => s.toggleSchema);
  const toggleGroup = useExplorerStore((s) => s.toggleGroup);
  const refresh = useExplorerStore((s) => s.refreshSchema);
  const openConsole = useSessionsStore((s) => s.openConsole);

  const objects = node?.objects ?? null;
  const filtered = (list: { name: string }[]) => (query ? list.filter((o) => o.name.toLowerCase().includes(query)) : list);
  const hasHits =
    query !== "" && objects !== null && GROUPS.some((g) => filtered(objects[g.id] as { name: string }[]).length > 0);
  const isOpen = (node?.expanded ?? false) || hasHits;

  return (
    <>
      <RowContextMenu
        entries={() =>
          schemaMenuEntries({
            schema: schema.name,
            onOpenConsole: () => {
              const id = openConsole(connection, database);
              useConsoleStore.getState().setScript(id, `SET search_path TO ${schema.name}, public;\n\n`);
            },
            onDiagram: () => useSessionsStore.getState().openDiagram(connection, database, schema.name),
            onRefresh: () => void refresh(connection.id, sessionId, database, schema.name),
          })
        }
      >
        <TreeRow
          depth={depth}
          expanded={isOpen}
          title={schema.comment ?? schema.name}
          icon={<Layers className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
          label={<Highlighted name={schema.name} query={query} />}
          trailing={schema.system && <span>system</span>}
          onActivate={() => void toggle(connection.id, sessionId, database, schema.name)}
        />
      </RowContextMenu>
      {isOpen && (
        <div role="group">
          {node?.error ? (
            <TreeNote depth={depth + 1} tone="danger">
              {node.error}
            </TreeNote>
          ) : (
            node?.loading && !node.loaded && <TreeNote depth={depth + 1}>Loading…</TreeNote>
          )}
          {objects &&
            GROUPS.map((g) => {
              const items = filtered(objects[g.id] as { name: string }[]);
              if (items.length === 0 && (query || g.id !== "tables")) return null;
              const gKey = groupKey(connection.id, database, schema.name, g.id);
              const open = groupOpen(groups, gKey) || (query !== "" && items.length > 0);
              return (
                <ObjectGroupRows
                  key={g.id}
                  group={g}
                  items={items}
                  open={open}
                  depth={depth + 1}
                  onToggle={() => toggleGroup(gKey)}
                  schema={schema.name}
                  database={database}
                  sessionId={sessionId}
                  connection={connection}
                  query={query}
                />
              );
            })}
        </div>
      )}
    </>
  );
}

interface ObjectGroupRowsProps {
  group: { id: ObjectGroup; label: string; icon: LucideIcon };
  items: { name: string }[];
  open: boolean;
  depth: number;
  onToggle: () => void;
  schema: string;
  database: string;
  sessionId: string;
  connection: TabConnection;
  query: string;
}

/** A group header (Tables, Views...) and its items, windowed when long. */
function ObjectGroupRows({ group, items, open, depth, onToggle, schema, database, sessionId, connection, query }: ObjectGroupRowsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useWindowedRows(listRef, open ? items.length : 0);
  const activeTable = useSessionsStore((s) => {
    const tab = selectActiveTab(s);
    return tab?.kind === "table" && tab.connection.id === connection.id && tab.database === database && tab.schema === schema
      ? tab.table
      : null;
  });
  const Icon = group.icon;
  const readOnly = useConnectionsStore((s) => s.sessions[connection.id]?.readOnly ?? false);

  return (
    <>
      <TreeRow
        depth={depth}
        expanded={open}
        icon={
          open ? (
            <FolderOpen className="size-3.5 shrink-0 text-fg-2" aria-hidden />
          ) : (
            <Folder className="size-3.5 shrink-0 text-fg-2" aria-hidden />
          )
        }
        label={group.label}
        trailing={<span>{items.length}</span>}
        onActivate={onToggle}
      />
      {open && (
        <div role="group" ref={listRef}>
          {items.length === 0 && <TreeNote depth={depth + 1}>None</TreeNote>}
          {rows.padTop > 0 && <div aria-hidden style={{ height: rows.padTop }} />}
          {items.slice(rows.start, rows.end).map((item) => {
            if (group.id === "functions") {
              const fn = item as FunctionEntry;
              return (
                <RowContextMenu
                  key={`${fn.name}(${fn.args})`}
                  entries={() =>
                    functionMenuEntries({
                      name: fn.name,
                      signature: `${schema}.${fn.name}(${fn.args})`,
                      onShow: () => void showDefinition(connection, sessionId, database, schema, fn.name, "function", fn.oid),
                    })
                  }
                >
                  <TreeRow
                    depth={depth + 1}
                    title={`${fn.name}(${fn.args})${fn.returns ? ` → ${fn.returns}` : ""}`}
                    icon={<Icon className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
                    label={
                      <>
                        <Highlighted name={fn.name} query={query} />
                        <span className="text-fg-3">({fn.args})</span>
                      </>
                    }
                    trailing={fn.kind === "p" ? <span>procedure</span> : fn.kind === "a" ? <span>aggregate</span> : undefined}
                    onActivate={() => void showDefinition(connection, sessionId, database, schema, fn.name, "function", fn.oid)}
                  />
                </RowContextMenu>
              );
            }
            if (group.id === "types") {
              const ty = item as TypeEntry;
              const kind = { e: "enum", c: "composite", d: "domain", r: "range" }[ty.kind];
              return (
                <RowContextMenu
                  key={ty.name}
                  entries={() =>
                    typeMenuEntries({ name: ty.name, onShow: () => void showDefinition(connection, sessionId, database, schema, ty.name, "type") })
                  }
                >
                  <TreeRow
                    depth={depth + 1}
                    icon={<Icon className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
                    label={<Highlighted name={ty.name} query={query} />}
                    trailing={<span>{kind}</span>}
                    onActivate={() => void showDefinition(connection, sessionId, database, schema, ty.name, "type")}
                  />
                </RowContextMenu>
              );
            }
            const rel = item as RelationEntry;
            const isSequence = group.id === "sequences";
            const open = () =>
              isSequence
                ? void showDefinition(connection, sessionId, database, schema, rel.name, "sequence")
                : void useSessionsStore.getState().openTable(sessionId, connection, database, schema, rel.name, rel.kind);
            return (
              <RowContextMenu
                key={rel.name}
                entries={() =>
                  relationMenuEntries({
                    name: rel.name,
                    qualified: `${schema}.${rel.name}`,
                    isSequence,
                    onOpen: open,
                    onOpenSql: () => {
                      void useSessionsStore.getState().openTable(sessionId, connection, database, schema, rel.name, rel.kind);
                      useUiStore.getState().setMainTab(`${connection.id}/${database}/${schema}.${rel.name}`, "sql");
                    },
                    onStructure: () => {
                      void useSessionsStore.getState().openTable(sessionId, connection, database, schema, rel.name, rel.kind);
                      useUiStore.getState().setMainTab(`${connection.id}/${database}/${schema}.${rel.name}`, "structure");
                    },
                    onDiagram: ["r", "p", "f"].includes(rel.kind)
                      ? () => useSessionsStore.getState().openDiagram(connection, database, schema, rel.name)
                      : undefined,
                    kind: rel.kind,
                    readOnly,
                    onMaintenance: (action) =>
                      void runMaintenance({ connection, sessionId, database, schema, table: rel.name }, action),
                    onGenerate: (kind) => void generateSql({ connection, sessionId, database, schema, table: rel.name }, kind),
                    onImportCsv: ["r", "p"].includes(rel.kind)
                      ? () => openImportCsv(connection, database, schema, rel.name)
                      : undefined,
                    importDisabled: useConnectionsStore.getState().sessions[connection.id]?.readOnly ?? false,
                    onShowDefinition: () =>
                      void showDefinition(connection, sessionId, database, schema, rel.name, isSequence ? "sequence" : "table"),
                  })
                }
              >
                <TreeRow
                  depth={depth + 1}
                  selected={activeTable === rel.name}
                  title={rel.comment ? `${rel.name}: ${rel.comment}` : rel.name}
                  icon={<Icon className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
                  label={<Highlighted name={rel.name} query={query} />}
                  trailing={
                    rel.kind === "p" ? (
                      <span>partitioned</span>
                    ) : rel.kind === "f" ? (
                      <span>foreign</span>
                    ) : rel.rowEstimate !== null && !isSequence && group.id !== "views" ? (
                      <span title={`About ${rel.rowEstimate.toLocaleString("en-US")} rows`}>{formatCount(rel.rowEstimate)}</span>
                    ) : undefined
                  }
                  onActivate={open}
                />
              </RowContextMenu>
            );
          })}
          {rows.padBottom > 0 && <div aria-hidden style={{ height: rows.padBottom }} />}
        </div>
      )}
    </>
  );
}
