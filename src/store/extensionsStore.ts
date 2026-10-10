import { create } from "zustand";
import { objectsApi } from "../lib/objectsApi";
import type { ExtensionInfo } from "../types/objects";
import { databaseKey, schemaKey, useExplorerStore } from "./explorerStore";

/** The extensions installed in each database the Explorer shows, by database key. */
export interface ExtensionsNode {
  /** The session they were read on: a reconnect makes them stale. */
  sessionId: string;
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  items: ExtensionInfo[];
}

interface ExtensionsState {
  nodes: Record<string, ExtensionsNode>;
  toggle: (connectionId: string, database: string) => void;
  /** Reads the list unless this session already has it. */
  ensure: (connectionId: string, sessionId: string, database: string) => Promise<void>;
  load: (connectionId: string, sessionId: string, database: string) => Promise<void>;
}

const blank = (sessionId: string): ExtensionsNode => ({ sessionId, expanded: false, loading: false, loaded: false, error: null, items: [] });

export const useExtensionsStore = create<ExtensionsState>((set, get) => {
  function patch(key: string, sessionId: string, change: Partial<ExtensionsNode>) {
    set((s) => {
      const current = s.nodes[key];
      const base = current && current.sessionId === sessionId ? current : { ...blank(sessionId), expanded: current?.expanded ?? false };
      return { nodes: { ...s.nodes, [key]: { ...base, ...change } } };
    });
  }

  return {
    nodes: {},

    toggle: (connectionId, database) =>
      set((s) => {
        const key = databaseKey(connectionId, database);
        const node = s.nodes[key];
        return { nodes: { ...s.nodes, [key]: { ...(node ?? blank("")), expanded: !node?.expanded } } };
      }),

    ensure: async (connectionId, sessionId, database) => {
      const node = get().nodes[databaseKey(connectionId, database)];
      if (node && node.sessionId === sessionId && (node.loaded || node.loading)) return;
      await get().load(connectionId, sessionId, database);
    },

    load: async (connectionId, sessionId, database) => {
      const key = databaseKey(connectionId, database);
      patch(key, sessionId, { loading: true, error: null });
      try {
        patch(key, sessionId, { items: await objectsApi.listExtensions(sessionId, database), loaded: true, loading: false });
      } catch (e) {
        patch(key, sessionId, { error: String(e), loading: false });
      }
    },
  };
});

/**
 * After a change to a database's extensions: they bring tables, functions
 * and types, so the lists the Explorer holds for it are read again.
 */
export async function refreshAfterExtensionChange(connectionId: string, sessionId: string, database: string): Promise<void> {
  const explorer = useExplorerStore.getState();
  await explorer.refreshDatabase(connectionId, sessionId, database);
  const prefix = `${schemaKey(connectionId, database, "")}`;
  const loaded = Object.keys(useExplorerStore.getState().schemas).filter((k) => k.startsWith(prefix));
  await Promise.all(loaded.map((k) => explorer.refreshSchema(connectionId, sessionId, database, k.slice(prefix.length))));
  await useExtensionsStore.getState().load(connectionId, sessionId, database);
}
