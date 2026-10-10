import { create } from "zustand";
import { clearPropertyCache } from "../lib/cypherCompletion";
import { graphApi } from "../lib/tauri";
import type { GraphCatalog } from "../types/pg";
import { databaseKey, useExplorerStore } from "./explorerStore";

/**
 * What each opened database has beyond plain SQL: Apache AGE graphs with
 * their labels, whether pgvector is installed, SQL/PGQ property graphs.
 * Read when a database opens in the explorer and kept until refreshed or
 * the connection goes; most databases have none of it and show nothing.
 */
export interface GraphNode {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  catalog: GraphCatalog | null;
}

interface GraphState {
  /** By `connectionId/database`. */
  nodes: Record<string, GraphNode>;
  /** Expanded rows: the Graphs group, and each graph, by key. */
  open: Record<string, boolean>;

  /** Reads the database's graphs unless they were read already. */
  ensure: (connectionId: string, sessionId: string, database: string) => Promise<void>;
  /** Reads them again, after graphs or labels changed. */
  refresh: (connectionId: string, sessionId: string, database: string) => Promise<void>;
  toggle: (key: string) => void;
}

const idle: GraphNode = { loading: false, loaded: false, error: null, catalog: null };

export const graphGroupKey = (connectionId: string, database: string) => `${databaseKey(connectionId, database)}#graphs`;
export const graphKey = (connectionId: string, database: string, graph: string) => `${databaseKey(connectionId, database)}#graph:${graph}`;

export const useGraphStore = create<GraphState>((set, get) => {
  function patch(key: string, changes: Partial<GraphNode>) {
    set((s) => ({ nodes: { ...s.nodes, [key]: { ...(s.nodes[key] ?? idle), ...changes } } }));
  }

  async function load(connectionId: string, sessionId: string, database: string) {
    const key = databaseKey(connectionId, database);
    patch(key, { loading: true, error: null });
    try {
      const catalog = await graphApi.graphCatalog(sessionId, database);
      // the connection may have gone meanwhile
      if (useExplorerStore.getState().databases[key]) patch(key, { catalog, loaded: true, loading: false });
    } catch (e) {
      patch(key, { error: String(e), loading: false });
    }
  }

  return {
    nodes: {},
    open: {},

    ensure: async (connectionId, sessionId, database) => {
      const node = get().nodes[databaseKey(connectionId, database)];
      if (node?.loaded || node?.loading) return;
      await load(connectionId, sessionId, database);
    },

    refresh: async (connectionId, sessionId, database) => {
      if (!get().nodes[databaseKey(connectionId, database)]) return;
      // the sampled property names may have changed along with the graph
      clearPropertyCache();
      await load(connectionId, sessionId, database);
    },

    toggle: (key) => set((s) => ({ open: { ...s.open, [key]: !(s.open[key] ?? key.endsWith("#graphs")) } })),
  };
});

/** Whether a row is expanded: the Graphs group starts open, each graph closed. */
export function graphOpen(open: Record<string, boolean>, key: string): boolean {
  return open[key] ?? key.endsWith("#graphs");
}

// A disconnected connection takes its databases with it, the explorer's
// bookkeeping included.
useExplorerStore.subscribe((state, prev) => {
  if (state.databases === prev.databases) return;
  const { nodes, open } = useGraphStore.getState();
  const stale = Object.keys(nodes).filter((k) => !state.databases[k]);
  if (stale.length === 0) return;
  const gone = (k: string) => stale.some((s) => k === s || k.startsWith(`${s}#`));
  useGraphStore.setState({
    nodes: Object.fromEntries(Object.entries(nodes).filter(([k]) => !stale.includes(k))),
    open: Object.fromEntries(Object.entries(open).filter(([k]) => !gone(k))),
  });
});
