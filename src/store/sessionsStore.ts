import { create } from "zustand";
import { api } from "../lib/tauri";
import { sessionIdFor } from "./connectionsStore";
import { ident as quoteIdent } from "../lib/editSql";
import type { BrowseResult, CellValue, RelKind, Row, RowEdit, TableInfo } from "../types/pg";

/** The connection a tab was opened on, as shown on the tab. */
export interface TabConnection {
  id: string;
  name: string;
  /** Server address with credentials masked. */
  summary: string;
}

/** A row being added: a value per column, or undefined for its DEFAULT. */
export type NewRow = Record<string, string | null | undefined>;

/** One open table or view, with its query, page, structure and pending edits. */
export interface TableTab {
  kind: "table";
  id: string;
  connection: TabConnection;
  database: string;
  schema: string;
  table: string;
  relkind: RelKind;
  info: TableInfo | null;
  infoError: string | null;
  page: BrowseResult | null;
  whereText: string;
  orderByText: string;
  limit: number;
  offset: number;
  loading: boolean;
  /** The running query's execution id, for Cancel. */
  runId?: string | null;
  error: string | null;
  /** How long the page took, round trip included, in ms. */
  queryMs: number | null;
  /** The exact count of rows the filter matches, once asked for. */
  exactCount: number | null;
  counting: boolean;
  /** Changed values by row index in `page.rows`, then column name. */
  edits: Record<number, Record<string, string | null>>;
  inserted: NewRow[];
  /** Row indexes in `page.rows` marked for deletion. */
  deleted: number[];
  committing: boolean;
  commitError: string | null;
  selectedRow: number | null;
  /** The WHERE field the Assistant last wrote, until the user edits it. */
  assistantSource?: "where" | null;
}

/** A SQL console on its own, bound to one database of one connection. */
export interface ConsoleTab {
  kind: "console";
  id: string;
  connection: TabConnection;
  database: string;
  /** Numbers consoles on the same database apart: 1, 2, ... */
  number: number;
  /** Opened with SQL the Assistant wrote. */
  fromAssistant?: boolean;
}

/** A schema's tables and the foreign keys between them. */
export interface DiagramTab {
  kind: "diagram";
  id: string;
  connection: TabConnection;
  database: string;
  schema: string;
  /** The table selected when it opened, if any. */
  focus: string | null;
}

/** The server's sessions, locks and TimescaleDB jobs, one tab per connection and database. */
export interface ActivityTab {
  kind: "activity";
  id: string;
  connection: TabConnection;
  database: string;
  /** The view it opens on; the tab keeps the one the user switched to. */
  view?: "sessions" | "locks" | "jobs";
}

export type Tab = TableTab | ConsoleTab | DiagramTab | ActivityTab;

export type TabQueryFields = Pick<TableTab, "whereText" | "orderByText" | "limit" | "offset">;

export function hasPendingEdits(tab: TableTab): boolean {
  return Object.keys(tab.edits).length > 0 || tab.inserted.length > 0 || tab.deleted.length > 0;
}

export function pendingCount(tab: TableTab): number {
  return Object.keys(tab.edits).length + tab.inserted.length + tab.deleted.length;
}

interface SessionsState {
  tabs: Tab[];
  activeTabId: string | null;

  /** Focuses the table's tab, opening one if needed; `where` sets its filter. */
  openTable: (
    sessionId: string,
    connection: TabConnection,
    database: string,
    schema: string,
    table: string,
    relkind: RelKind,
    options?: { where?: string },
  ) => Promise<void>;
  /** Opens a new console on the database; returns its tab id. */
  openConsole: (connection: TabConnection, database: string, options?: { fromAssistant?: boolean }) => string;
  /** Focuses the schema's diagram, opening it if needed; `focus` selects a table. */
  openDiagram: (connection: TabConnection, database: string, schema: string, focus?: string) => void;
  /** Focuses the database's activity monitor, opening it if needed; `view` picks its view. */
  openActivity: (connection: TabConnection, database: string, options?: { view?: "jobs" | "sessions" | "locks" }) => void;
  /** Points a console tab at another database of its connection. */
  switchConsoleDatabase: (id: string, database: string) => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  closeAllTabs: () => void;
  updateTab: (id: string, patch: Partial<TabQueryFields>) => void;
  /** Puts a WHERE condition the Assistant wrote into the tab, marked as its. */
  applyWhere: (id: string, where: string) => void;
  selectRow: (id: string, row: number | null) => void;
  loadInfo: (sessionId: string, id: string) => Promise<void>;
  runQuery: (sessionId: string, id: string) => Promise<void>;
  cancelQuery: (id: string) => void;
  countRows: (sessionId: string, id: string) => Promise<void>;
  editCell: (id: string, row: number, column: string, value: string | null) => void;
  revertCell: (id: string, row: number, column: string) => void;
  addRow: (id: string) => void;
  editNewRow: (id: string, index: number, column: string, value: string | null | undefined) => void;
  removeNewRow: (id: string, index: number) => void;
  toggleDeleted: (id: string, rows: number[]) => void;
  discardEdits: (id: string) => void;
  commitEdits: (sessionId: string, id: string) => Promise<boolean>;
  /** Forgets a connection going away: its tabs. */
  closeConnection: (connectionId: string) => void;
  /** A connection was renamed or re-pointed: its tabs show the new name. */
  renameConnection: (connection: TabConnection) => void;
}

/** Unique per relation per connection. */
export function tabIdFor(connectionId: string, database: string, schema: string, table: string): string {
  return `${connectionId}/${database}/${schema}.${table}`;
}

export function selectActiveTab(state: SessionsState): Tab | null {
  return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
}

/** Numbers consoles on one database apart: one past the highest open. */
function nextConsoleNumber(tabs: Tab[], connectionId: string, database: string): number {
  const numbers = tabs
    .filter((t): t is ConsoleTab => t.kind === "console" && t.connection.id === connectionId && t.database === database)
    .map((t) => t.number);
  return Math.max(0, ...numbers) + 1;
}

function newTableTab(
  connection: TabConnection,
  database: string,
  schema: string,
  table: string,
  relkind: RelKind,
  where: string,
): TableTab {
  return {
    kind: "table",
    id: tabIdFor(connection.id, database, schema, table),
    connection,
    database,
    schema,
    table,
    relkind,
    info: null,
    infoError: null,
    page: null,
    whereText: where,
    orderByText: "",
    limit: 100,
    offset: 0,
    loading: false,
    error: null,
    queryMs: null,
    exactCount: null,
    counting: false,
    edits: {},
    inserted: [],
    deleted: [],
    committing: false,
    commitError: null,
    selectedRow: null,
  };
}

/** A key's cells for a row, by the table's row key. */
function keyOf(info: TableInfo, page: BrowseResult, row: Row): CellValue[] {
  return info.rowKey.map((column) => {
    const i = page.columns.findIndex((c) => c.name === column);
    return { column, value: i >= 0 ? row[i] : null };
  });
}

/** Lets the tab's own connections go when the tab does. */
function release(tab: Tab) {
  const sessionId = sessionIdFor(tab.connection.id);
  if (sessionId) void api.releaseTab(sessionId, tab.id).catch(() => {});
}

export const useSessionsStore = create<SessionsState>((set, get) => {
  // Requests outlive the tab that made them when it's closed mid-flight;
  // patching a tab that's gone is simply a no-op.
  function patchTab(id: string, patch: Partial<Omit<TableTab, "kind">> | ((t: TableTab) => Partial<TableTab>)) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id && t.kind === "table" ? { ...t, ...(typeof patch === "function" ? patch(t) : patch) } : t,
      ),
    }));
  }

  function tableTab(id: string): TableTab | null {
    const tab = get().tabs.find((t) => t.id === id);
    return tab?.kind === "table" ? tab : null;
  }

  return {
    tabs: [],
    activeTabId: null,

    openTable: async (sessionId, connection, database, schema, table, relkind, options) => {
      const id = tabIdFor(connection.id, database, schema, table);
      const existing = tableTab(id);
      if (existing) {
        set({ activeTabId: id });
        if (options?.where !== undefined && options.where !== existing.whereText) {
          patchTab(id, { whereText: options.where, offset: 0, exactCount: null });
          await get().runQuery(sessionId, id);
        }
        return;
      }
      set((s) => ({
        tabs: [...s.tabs, { ...newTableTab(connection, database, schema, table, relkind, options?.where ?? ""), loading: true }],
        activeTabId: id,
      }));
      // The structure comes first (a quick catalog read): it gives the key
      // to order pages by, so paging is stable, and the types and keys the
      // grid marks.
      await get().loadInfo(sessionId, id);
      const info = tableTab(id)?.info;
      if (info && info.rowKey.length > 0 && !tableTab(id)?.orderByText) {
        patchTab(id, { orderByText: info.rowKey.map(quoteIdent).join(", ") });
      }
      await get().runQuery(sessionId, id);
    },

    openConsole: (connection, database, options) => {
      const tab: ConsoleTab = {
        kind: "console",
        id: `console:${crypto.randomUUID()}`,
        connection,
        database,
        number: nextConsoleNumber(get().tabs, connection.id, database),
        fromAssistant: options?.fromAssistant ?? false,
      };
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
      return tab.id;
    },

    openDiagram: (connection, database, schema, focus) => {
      const id = `diagram:${connection.id}/${database}/${schema}`;
      set((s) => {
        const open = s.tabs.find((t) => t.id === id);
        if (open) {
          const tabs = focus ? s.tabs.map((t) => (t.id === id ? { ...t, focus } : t)) : s.tabs;
          return { tabs, activeTabId: id };
        }
        const tab: DiagramTab = { kind: "diagram", id, connection, database, schema, focus: focus ?? null };
        return { tabs: [...s.tabs, tab], activeTabId: id };
      });
    },

    openActivity: (connection, database, options) => {
      const id = `activity:${connection.id}/${database}`;
      set((s) => {
        if (s.tabs.some((t) => t.id === id)) {
          const tabs = options?.view ? s.tabs.map((t) => (t.id === id && t.kind === "activity" ? { ...t, view: options.view } : t)) : s.tabs;
          return { tabs, activeTabId: id };
        }
        const tab: ActivityTab = { kind: "activity", id, connection, database, view: options?.view };
        return { tabs: [...s.tabs, tab], activeTabId: id };
      });
    },

    switchConsoleDatabase: (id, database) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === id && t.kind === "console" && t.database !== database
            ? { ...t, database, number: nextConsoleNumber(s.tabs, t.connection.id, database) }
            : t,
        ),
      })),

    activateTab: (id) => set({ activeTabId: id }),

    closeTab: (id) =>
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === id);
        if (index === -1) return s;
        release(s.tabs[index]);
        const tabs = s.tabs.filter((t) => t.id !== id);
        // Closing the active tab hands focus to its right neighbour, or the
        // left one when it was last - the way editor tabs behave.
        const activeTabId =
          s.activeTabId === id ? ((tabs[index] ?? tabs[index - 1])?.id ?? null) : s.activeTabId;
        return { tabs, activeTabId };
      }),

    closeOtherTabs: (id) =>
      set((s) => {
        if (!s.tabs.some((t) => t.id === id)) return s;
        s.tabs.filter((t) => t.id !== id).forEach(release);
        return { tabs: s.tabs.filter((t) => t.id === id), activeTabId: id };
      }),

    closeAllTabs: () =>
      set((s) => {
        s.tabs.forEach(release);
        return { tabs: [], activeTabId: null };
      }),

    updateTab: (id, patch) => {
      const tab = tableTab(id);
      const edited = tab?.assistantSource === "where" && patch.whereText !== undefined && patch.whereText !== tab.whereText;
      patchTab(id, edited ? { ...patch, assistantSource: null } : patch);
    },

    applyWhere: (id, where) => patchTab(id, { whereText: where, offset: 0, assistantSource: "where" }),

    selectRow: (id, row) => patchTab(id, { selectedRow: row }),

    loadInfo: async (sessionId, id) => {
      const tab = tableTab(id);
      if (!tab) return;
      try {
        const info = await api.describeTable(sessionId, tab.database, tab.schema, tab.table);
        patchTab(id, { info, infoError: null });
      } catch (e) {
        patchTab(id, { infoError: String(e) });
      }
    },

    runQuery: async (sessionId, id) => {
      const tab = tableTab(id);
      if (!tab) return;
      // running again replaces a query still going
      if (tab.runId) void api.cancelQuery(tab.runId);
      const runId = crypto.randomUUID();
      const current = () => tableTab(id)?.runId === runId;
      patchTab(id, { loading: true, error: null, runId });
      const started = performance.now();
      try {
        const page = await api.browseTable(
          sessionId,
          tab.database,
          tab.schema,
          tab.table,
          {
            whereClause: tab.whereText.trim() || null,
            orderBy: tab.orderByText.trim() || null,
            limit: tab.limit,
            offset: tab.offset,
          },
          runId,
        );
        if (current()) {
          patchTab(id, {
            page,
            queryMs: Math.round(performance.now() - started),
            loading: false,
            runId: null,
            // a new page: what was pending belonged to the old one
            edits: {},
            inserted: [],
            deleted: [],
            commitError: null,
            selectedRow: page.rows.length > 0 ? 0 : null,
          });
        }
      } catch (e) {
        if (current()) patchTab(id, { error: String(e), loading: false, runId: null });
      }
    },

    cancelQuery: (id) => {
      const tab = tableTab(id);
      if (!tab?.runId) return;
      void api.cancelQuery(tab.runId);
      patchTab(id, {
        loading: false,
        runId: null,
        error: tab.page ? "Cancelled. The rows below are from the previous run." : "Cancelled.",
      });
    },

    countRows: async (sessionId, id) => {
      const tab = tableTab(id);
      if (!tab) return;
      patchTab(id, { counting: true });
      try {
        const n = await api.countRows(sessionId, tab.database, tab.schema, tab.table, tab.whereText.trim() || null);
        patchTab(id, { exactCount: n, counting: false });
      } catch (e) {
        patchTab(id, { counting: false, error: String(e) });
      }
    },

    editCell: (id, row, column, value) =>
      patchTab(id, (t) => {
        const original = t.page?.rows[row]?.[t.page.columns.findIndex((c) => c.name === column)];
        const rowEdits = { ...(t.edits[row] ?? {}) };
        // Typing the stored value back is no change at all.
        if (original === value) delete rowEdits[column];
        else rowEdits[column] = value;
        const edits = { ...t.edits };
        if (Object.keys(rowEdits).length === 0) delete edits[row];
        else edits[row] = rowEdits;
        return { edits, commitError: null };
      }),

    revertCell: (id, row, column) =>
      patchTab(id, (t) => {
        const rowEdits = { ...(t.edits[row] ?? {}) };
        delete rowEdits[column];
        const edits = { ...t.edits };
        if (Object.keys(rowEdits).length === 0) delete edits[row];
        else edits[row] = rowEdits;
        return { edits };
      }),

    addRow: (id) => patchTab(id, (t) => ({ inserted: [...t.inserted, {}], commitError: null })),

    editNewRow: (id, index, column, value) =>
      patchTab(id, (t) => ({
        inserted: t.inserted.map((r, i) => (i === index ? { ...r, [column]: value } : r)),
      })),

    removeNewRow: (id, index) => patchTab(id, (t) => ({ inserted: t.inserted.filter((_, i) => i !== index) })),

    toggleDeleted: (id, rows) =>
      patchTab(id, (t) => {
        const set = new Set(t.deleted);
        const allMarked = rows.every((r) => set.has(r));
        for (const r of rows) {
          if (allMarked) set.delete(r);
          else set.add(r);
        }
        return { deleted: [...set].sort((a, b) => a - b), commitError: null };
      }),

    discardEdits: (id) => patchTab(id, { edits: {}, inserted: [], deleted: [], commitError: null }),

    commitEdits: async (sessionId, id) => {
      const tab = tableTab(id);
      if (!tab?.page || !tab.info) return false;
      const { page, info } = tab;
      const edits: RowEdit[] = [];
      const updatedRows: number[] = [];
      for (const [rowText, values] of Object.entries(tab.edits)) {
        const row = Number(rowText);
        if (tab.deleted.includes(row)) continue;
        edits.push({
          kind: "update",
          key: keyOf(info, page, page.rows[row]),
          values: Object.entries(values).map(([column, value]) => ({ column, value })),
        });
        updatedRows.push(row);
      }
      for (const row of tab.inserted) {
        edits.push({
          kind: "insert",
          values: info.columns.map((c) =>
            row[c.name] === undefined ? { column: c.name, value: null, useDefault: true } : { column: c.name, value: row[c.name] ?? null },
          ),
        });
      }
      for (const row of tab.deleted) edits.push({ kind: "delete", key: keyOf(info, page, page.rows[row]) });
      if (edits.length === 0) return true;
      patchTab(id, { committing: true, commitError: null });
      try {
        const applied = await api.applyEdits(sessionId, tab.database, tab.schema, tab.table, tab.id, edits);
        patchTab(id, (t) => {
          if (!t.page) return { committing: false };
          const rows = [...t.page.rows];
          updatedRows.forEach((row, i) => {
            const stored = applied.rows[i];
            if (stored) rows[row] = stored;
          });
          const added = applied.rows.slice(updatedRows.length, updatedRows.length + t.inserted.length).filter((r): r is Row => r !== null);
          const kept = rows.filter((_, i) => !t.deleted.includes(i));
          return {
            committing: false,
            page: { ...t.page, rows: [...kept, ...added] },
            edits: {},
            inserted: [],
            deleted: [],
            exactCount: null,
          };
        });
        return true;
      } catch (e) {
        patchTab(id, { committing: false, commitError: String(e) });
        return false;
      }
    },

    renameConnection: (connection) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.connection.id === connection.id &&
          (t.connection.name !== connection.name || t.connection.summary !== connection.summary)
            ? { ...t, connection }
            : t,
        ),
      })),

    closeConnection: (connectionId) =>
      set((s) => {
        const tabs = s.tabs.filter((t) => t.connection.id !== connectionId);
        const activeGone = !tabs.some((t) => t.id === s.activeTabId);
        return { tabs, activeTabId: activeGone ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId };
      }),
  };
});
