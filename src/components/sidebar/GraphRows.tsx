import { useEffect } from "react";
import { ArrowRight, CircleDot, Folder, FolderOpen, Network, Share2 } from "lucide-react";
import { graphKey, graphGroupKey, graphOpen, useGraphStore } from "../../store/graphStore";
import { useConsoleStore } from "../../store/consoleStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { TabConnection } from "../../store/sessionsStore";
import type { GraphInfo, GraphLabel, PropertyGraphInfo } from "../../types/pg";
import { RowContextMenu } from "@/components/common/ActionMenu";
import { formatCount } from "@/lib/format";
import { graphScript, labelScript, propertyGraphScript } from "@/lib/cypher";
import { Highlighted } from "./Highlighted";
import { TreeRow } from "./TreeRow";
import { graphLabelMenuEntries, graphMenuEntries, propertyGraphMenuEntries } from "./treeMenus";

interface GraphRowsProps {
  database: string;
  sessionId: string;
  connection: TabConnection;
  depth: number;
  /** Only read while the database is open. */
  active: boolean;
  /** The sidebar search, lowercased. */
  query: string;
}

/** Opens a console on the database holding `script`. */
function openScript(connection: TabConnection, database: string, script: string) {
  const id = useSessionsStore.getState().openConsole(connection, database);
  useConsoleStore.getState().setScript(id, script);
}

/**
 * The "Graphs" group of a database: Apache AGE graphs with their labels,
 * and SQL/PGQ property graphs where the server has them. Shows nothing at
 * all in a database with neither.
 */
export function GraphRows({ database, sessionId, connection, depth, active, query }: GraphRowsProps) {
  const ensure = useGraphStore((s) => s.ensure);
  const catalog = useGraphStore((s) => s.nodes[`${connection.id}/${database}`]?.catalog ?? null);
  const open = useGraphStore((s) => s.open);
  const toggle = useGraphStore((s) => s.toggle);

  useEffect(() => {
    if (active) void ensure(connection.id, sessionId, database);
  }, [active, ensure, connection.id, sessionId, database]);

  if (!catalog || (!catalog.age && catalog.propertyGraphs.length === 0)) return null;

  const graphs = catalog.graphs.filter((g) => !query || g.name.toLowerCase().includes(query) || g.labels.some((l) => l.name.toLowerCase().includes(query)));
  const property = catalog.propertyGraphs.filter((g) => !query || g.name.toLowerCase().includes(query));
  const total = graphs.length + property.length;
  if (query && total === 0) return null;

  const groupKey = graphGroupKey(connection.id, database);
  const isOpen = graphOpen(open, groupKey) || (query !== "" && total > 0);
  return (
    <>
      <TreeRow
        depth={depth}
        expanded={isOpen}
        icon={
          isOpen ? (
            <FolderOpen className="size-3.5 shrink-0 text-fg-2" aria-hidden />
          ) : (
            <Folder className="size-3.5 shrink-0 text-fg-2" aria-hidden />
          )
        }
        label="Graphs"
        trailing={<span>{total}</span>}
        onActivate={() => toggle(groupKey)}
      />
      {isOpen && (
        <div role="group">
          {graphs.map((graph) => (
            <GraphRow key={graph.name} graph={graph} database={database} connection={connection} depth={depth + 1} query={query} open={open} />
          ))}
          {property.map((graph) => (
            <PropertyGraphRow key={`${graph.schema}.${graph.name}`} graph={graph} database={database} connection={connection} depth={depth + 1} />
          ))}
          {total === 0 && <TreeRow depth={depth + 1} icon={<span className="size-3.5" />} label={<span className="text-fg-3">None</span>} />}
        </div>
      )}
    </>
  );
}

interface GraphRowProps {
  graph: GraphInfo;
  database: string;
  connection: TabConnection;
  depth: number;
  query: string;
  open: Record<string, boolean>;
}

/** An AGE graph, opening to its vertex labels and then its edge labels. */
function GraphRow({ graph, database, connection, depth, query, open }: GraphRowProps) {
  const toggle = useGraphStore((s) => s.toggle);
  const key = graphKey(connection.id, database, graph.name);
  const labels = query && !graph.name.toLowerCase().includes(query) ? graph.labels.filter((l) => l.name.toLowerCase().includes(query)) : graph.labels;
  const isOpen = graphOpen(open, key) || (query !== "" && labels.length > 0);
  const vertices = graph.labels.filter((l) => l.kind === "v").length;
  const edges = graph.labels.length - vertices;
  return (
    <>
      <RowContextMenu
        entries={() => graphMenuEntries({ graph: graph.name, onNewQuery: () => openScript(connection, database, graphScript(graph.name)) })}
      >
        <TreeRow
          depth={depth}
          expanded={isOpen}
          title={`${graph.name}: ${vertices} vertex ${vertices === 1 ? "label" : "labels"}, ${edges} edge ${edges === 1 ? "label" : "labels"}`}
          icon={<Share2 className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
          label={<Highlighted name={graph.name} query={query} />}
          trailing={<span>{graph.labels.length}</span>}
          onActivate={() => toggle(key)}
        />
      </RowContextMenu>
      {isOpen && (
        <div role="group">
          {labels.length === 0 && <TreeRow depth={depth + 1} icon={<span className="size-3.5" />} label={<span className="text-fg-3">No labels yet</span>} />}
          {labels.map((label) => (
            <LabelRow key={`${label.kind}:${label.name}`} graph={graph.name} label={label} database={database} connection={connection} depth={depth + 1} query={query} />
          ))}
        </div>
      )}
    </>
  );
}

interface LabelRowProps {
  graph: string;
  label: GraphLabel;
  database: string;
  connection: TabConnection;
  depth: number;
  query: string;
}

function LabelRow({ graph, label, database, connection, depth, query }: LabelRowProps) {
  const Icon = label.kind === "v" ? CircleDot : ArrowRight;
  const match = () => openScript(connection, database, labelScript(graph, label.name, label.kind));
  return (
    <RowContextMenu entries={() => graphLabelMenuEntries({ graph, label: label.name, kind: label.kind, onMatch: match })}>
      <TreeRow
        depth={depth}
        title={`${label.kind === "v" ? "Vertex" : "Edge"} label ${label.name}`}
        icon={<Icon className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
        label={<Highlighted name={label.name} query={query} />}
        trailing={
          label.rowEstimate !== null ? (
            <span title={`About ${label.rowEstimate.toLocaleString("en-US")} ${label.kind === "v" ? "vertices" : "edges"}`}>{formatCount(label.rowEstimate)}</span>
          ) : undefined
        }
        onActivate={match}
      />
    </RowContextMenu>
  );
}

function PropertyGraphRow({ graph, database, connection, depth }: { graph: PropertyGraphInfo; database: string; connection: TabConnection; depth: number }) {
  const qualified = `${graph.schema}.${graph.name}`;
  const query = () => openScript(connection, database, propertyGraphScript(graph.schema, graph.name));
  return (
    <RowContextMenu entries={() => propertyGraphMenuEntries({ qualified, onQuery: query })}>
      <TreeRow
        depth={depth}
        title={graph.elements.length ? `${qualified}: ${graph.elements.join(", ")}` : qualified}
        icon={<Network className="size-3.5 shrink-0 text-fg-2" aria-hidden />}
        label={graph.name}
        trailing={<span>property graph</span>}
        onActivate={query}
      />
    </RowContextMenu>
  );
}
