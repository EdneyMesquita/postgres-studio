import { create } from "zustand";
import { api } from "../lib/tauri";
import type { SchemaInfo, SchemaObjects } from "../types/pg";

/**
 * The explorer tree below each connection: database > schema > object
 * groups. Purely visual state plus what was listed, fetched when a node
 * first opens and kept until refreshed or disconnected.
 */
export interface DatabaseNode {
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  schemas: SchemaInfo[];
}

export interface SchemaNode {
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  objects: SchemaObjects | null;
}

export type ObjectGroup = "tables" | "views" | "materializedViews" | "functions" | "sequences" | "types";

export const databaseKey = (connectionId: string, database: string) => `${connectionId}/${database}`;
export const schemaKey = (connectionId: string, database: string, schema: string) =>
  `${connectionId}/${database}/${schema}`;
export const groupKey = (connectionId: string, database: string, schema: string, group: ObjectGroup) =>
  `${connectionId}/${database}/${schema}#${group}`;

interface ExplorerState {
  databases: Record<string, DatabaseNode>;
  schemas: Record<string, SchemaNode>;
  /** Group expansion by groupKey; tables open by default. */
  groups: Record<string, boolean>;

  toggleDatabase: (connectionId: string, sessionId: string, database: string) => Promise<void>;
  toggleSchema: (connectionId: string, sessionId: string, database: string, schema: string) => Promise<void>;
  toggleGroup: (key: string) => void;
  /** Lists a database's schemas again. */
  refreshDatabase: (connectionId: string, sessionId: string, database: string) => Promise<void>;
  /** Lists a schema's objects again (after a CREATE or DROP). */
  refreshSchema: (connectionId: string, sessionId: string, database: string, schema: string) => Promise<void>;
  /** Opens the database a connection starts on, down to its main schema's tables. */
  openDefault: (connectionId: string, sessionId: string, database: string) => Promise<void>;
  forgetConnection: (connectionId: string) => void;
}

/** Beyond this many schemas, only the ones opened by hand are listed. */
const PREFETCH_SCHEMAS = 60;

const closedDatabase: DatabaseNode = { expanded: false, loading: false, loaded: false, error: null, schemas: [] };
const closedSchema: SchemaNode = { expanded: false, loading: false, loaded: false, error: null, objects: null };

export const useExplorerStore = create<ExplorerState>((set, get) => {
  function patchDatabase(key: string, patch: Partial<DatabaseNode>) {
    set((s) => ({ databases: { ...s.databases, [key]: { ...(s.databases[key] ?? closedDatabase), ...patch } } }));
  }
  function patchSchema(key: string, patch: Partial<SchemaNode>) {
    set((s) => ({ schemas: { ...s.schemas, [key]: { ...(s.schemas[key] ?? closedSchema), ...patch } } }));
  }

  async function loadSchemas(connectionId: string, sessionId: string, database: string) {
    const key = databaseKey(connectionId, database);
    patchDatabase(key, { loading: true, error: null });
    try {
      const schemas = await api.listSchemas(sessionId, database);
      if (get().databases[key]) patchDatabase(key, { schemas, loaded: true, loading: false });
      void prefetchObjects(connectionId, sessionId, database, schemas);
      return schemas;
    } catch (e) {
      if (get().databases[key]) patchDatabase(key, { error: String(e), loading: false });
      return null;
    }
  }

  async function loadObjects(connectionId: string, sessionId: string, database: string, schema: string) {
    const key = schemaKey(connectionId, database, schema);
    patchSchema(key, { loading: true, error: null });
    try {
      const objects = await api.listSchemaObjects(sessionId, database, schema);
      if (get().schemas[key]) patchSchema(key, { objects, loaded: true, loading: false });
    } catch (e) {
      if (get().schemas[key]) patchSchema(key, { error: String(e), loading: false });
    }
  }

  /**
   * Lists the objects of the user schemas not opened yet, a few at a time,
   * without expanding them: quick open and the Explorer search cover the
   * whole database, not only the schemas opened by hand.
   */
  async function prefetchObjects(connectionId: string, sessionId: string, database: string, schemas: SchemaInfo[]) {
    const pending = schemas
      .filter((s) => !s.system)
      .slice(0, PREFETCH_SCHEMAS)
      .map((s) => s.name)
      .filter((name) => {
        const node = get().schemas[schemaKey(connectionId, database, name)];
        return !node?.loaded && !node?.loading;
      });
    const worker = async () => {
      for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
        // the connection went away meanwhile
        if (!get().databases[databaseKey(connectionId, database)]) return;
        await loadObjects(connectionId, sessionId, database, name);
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
  }

  return {
    databases: {},
    schemas: {},
    groups: {},

    toggleDatabase: async (connectionId, sessionId, database) => {
      const key = databaseKey(connectionId, database);
      const node = get().databases[key] ?? closedDatabase;
      if (node.expanded) return patchDatabase(key, { expanded: false });
      patchDatabase(key, { expanded: true });
      if (!node.loaded && !node.loading) await loadSchemas(connectionId, sessionId, database);
    },

    toggleSchema: async (connectionId, sessionId, database, schema) => {
      const key = schemaKey(connectionId, database, schema);
      const node = get().schemas[key] ?? closedSchema;
      if (node.expanded) return patchSchema(key, { expanded: false });
      patchSchema(key, { expanded: true });
      if (!node.loaded && !node.loading) await loadObjects(connectionId, sessionId, database, schema);
    },

    toggleGroup: (key) =>
      set((s) => ({ groups: { ...s.groups, [key]: !(s.groups[key] ?? key.endsWith("#tables")) } })),

    refreshDatabase: async (connectionId, sessionId, database) => {
      await loadSchemas(connectionId, sessionId, database);
    },

    refreshSchema: async (connectionId, sessionId, database, schema) => {
      if (!get().schemas[schemaKey(connectionId, database, schema)]) return;
      await loadObjects(connectionId, sessionId, database, schema);
    },

    openDefault: async (connectionId, sessionId, database) => {
      const key = databaseKey(connectionId, database);
      patchDatabase(key, { expanded: true });
      const schemas = await loadSchemas(connectionId, sessionId, database);
      if (!schemas) return;
      const main = schemas.find((s) => s.name === "public") ?? schemas.find((s) => !s.system);
      if (!main) return;
      const mainKey = schemaKey(connectionId, database, main.name);
      patchSchema(mainKey, { expanded: true });
      // the prefetch may have started on it already
      const node = get().schemas[mainKey];
      if (!node?.loaded && !node?.loading) await loadObjects(connectionId, sessionId, database, main.name);
    },

    forgetConnection: (connectionId) =>
      set((s) => {
        const keep = <T,>(record: Record<string, T>) =>
          Object.fromEntries(Object.entries(record).filter(([k]) => !k.startsWith(`${connectionId}/`)));
        return { databases: keep(s.databases), schemas: keep(s.schemas), groups: keep(s.groups) };
      }),
  };
});

/** Whether a group shows its items: tables open by default, the rest closed. */
export function groupOpen(groups: Record<string, boolean>, key: string): boolean {
  return groups[key] ?? key.endsWith("#tables");
}
