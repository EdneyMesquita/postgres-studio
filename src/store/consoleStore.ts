import { create } from "zustand";
import { api } from "../lib/tauri";
import { useConnectionsStore } from "./connectionsStore";
import { selectActiveTab, useSessionsStore } from "./sessionsStore";
import type { Tab } from "./sessionsStore";
import { useUiStore } from "./uiStore";
import { useExplorerStore } from "./explorerStore";
import { clearColumnCache } from "../lib/sqlCompletion";
import type { ExplainResult, SqlRun, TxState } from "../types/pg";

/** Quotes an identifier only when it needs it. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** The SQL a console starts with: a look at its table, or a hint. */
export function defaultScript(tab: Tab): string {
  if (tab.kind === "table") {
    const name = `${quoteIdent(tab.schema)}.${quoteIdent(tab.table)}`;
    return `-- Runs on ${tab.database}. Ctrl+Enter runs the statement at the caret; select text to run just that.
SELECT *
FROM ${name}
LIMIT 100;
`;
  }
  return `-- Runs on ${tab.database}. Ctrl+Enter runs the statement at the caret; select text to run just that.

`;
}

/** Which output a console shows: a statement's result, the messages, or the plan. */
export type ConsoleOutput = { kind: "result"; index: number } | { kind: "messages" } | { kind: "explain" };

export type TxMode = "auto" | "manual";

export interface ConsoleSession {
  /** Null until edited: the console shows its default SQL until then. */
  script: string | null;
  running: boolean;
  executionId: string | null;
  run: SqlRun | null;
  /** A failure of the app or connection, not of a statement. */
  error: string | null;
  output: ConsoleOutput;
  explain: ExplainResult | null;
  explaining: boolean;
  explainError: string | null;
  tx: TxState;
  txMode: TxMode;
  /** Where the text that ran started in the editor, for mapping error positions. */
  ranFrom: number;
}

const blankSession: ConsoleSession = {
  script: null,
  running: false,
  executionId: null,
  run: null,
  error: null,
  output: { kind: "result", index: 0 },
  explain: null,
  explaining: false,
  explainError: null,
  tx: "idle",
  txMode: "auto",
  ranFrom: 0,
};

/**
 * The console on screen - a console tab's, or a table tab's SQL view - with
 * its text. Read at call time, so it suits callbacks bound once, like
 * Monaco commands.
 */
export function currentConsoleTarget() {
  const tab = selectActiveTab(useSessionsStore.getState());
  if (!tab) return null;
  if (tab.kind === "diagram" || tab.kind === "activity") return null;
  if (tab.kind === "table" && (useUiStore.getState().mainTabs[tab.id] ?? "data") !== "sql") return null;
  const session = useConnectionsStore.getState().sessions[tab.connection.id] ?? null;
  const untouched = defaultScript(tab);
  const stored = useConsoleStore.getState().consoles[tab.id]?.script;
  return { tab, session, database: tab.database, key: tab.id, untouched, script: stored ?? untouched };
}

/** Statements that change what the explorer lists. */
const DDL = /^(CREATE|DROP|ALTER|COMMENT|TRUNCATE|REFRESH|GRANT|REVOKE)\b/;

interface ConsoleState {
  /** One console per tab, keyed by tab id. */
  consoles: Record<string, ConsoleSession>;

  setScript: (key: string, script: string) => void;
  setOutput: (key: string, output: ConsoleOutput) => void;
  /** Runs `sql`; with `caret`, only the statement at that character offset. `from` is where `sql` starts in the editor. */
  run: (key: string, sessionId: string, database: string, sql: string, caret: number | null, from?: number) => Promise<void>;
  explain: (key: string, sessionId: string, database: string, sql: string, analyze: boolean) => Promise<void>;
  cancel: (key: string) => Promise<void>;
  setTxMode: (key: string, sessionId: string, database: string, mode: TxMode) => Promise<void>;
  /** COMMIT or ROLLBACK on the tab's connection. */
  endTransaction: (key: string, sessionId: string, database: string, how: "COMMIT" | "ROLLBACK") => Promise<void>;
}

export const useConsoleStore = create<ConsoleState>((set, get) => {
  function patch(key: string, changes: Partial<ConsoleSession>) {
    set((s) => ({ consoles: { ...s.consoles, [key]: { ...(s.consoles[key] ?? blankSession), ...changes } } }));
  }

  /** After DDL, the explorer lists the schemas of that database again. */
  function refreshExplorer(key: string, run: SqlRun) {
    if (!run.results.some((r) => !r.error && DDL.test(r.command))) return;
    clearColumnCache();
    const tab = useSessionsStore.getState().tabs.find((t) => t.id === key);
    const session = tab && useConnectionsStore.getState().sessions[tab.connection.id];
    if (!tab || !session) return;
    const explorer = useExplorerStore.getState();
    for (const schemaKey of Object.keys(explorer.schemas)) {
      const prefix = `${tab.connection.id}/${tab.database}/`;
      if (schemaKey.startsWith(prefix)) {
        void explorer.refreshSchema(tab.connection.id, session.sessionId, tab.database, schemaKey.slice(prefix.length));
      }
    }
    void explorer.refreshDatabase(tab.connection.id, session.sessionId, tab.database);
  }

  return {
    consoles: {},

    setScript: (key, script) => patch(key, { script }),

    setOutput: (key, output) => patch(key, { output }),

    run: async (key, sessionId, database, sql, caret, from = 0) => {
      const executionId = crypto.randomUUID();
      const before = get().consoles[key] ?? blankSession;
      patch(key, { running: true, executionId, error: null, ranFrom: from });
      const stillCurrent = () => get().consoles[key]?.executionId === executionId;
      try {
        // Manual mode opens a transaction before the first statement.
        if (before.txMode === "manual" && before.tx === "idle") {
          await api.runSql(sessionId, database, key, "BEGIN", null, 1, null);
        }
        const run = await api.runSql(sessionId, database, key, sql, caret, 1000, executionId);
        if (!stillCurrent()) return;
        const failed = run.results.findIndex((r) => r.error);
        const firstWithRows = run.results.findIndex((r) => r.returnsRows);
        const output: ConsoleOutput =
          failed >= 0
            ? { kind: "result", index: failed }
            : firstWithRows >= 0
              ? { kind: "result", index: run.results.length - 1 - [...run.results].reverse().findIndex((r) => r.returnsRows) }
              : run.results.length > 0
                ? { kind: "result", index: run.results.length - 1 }
                : { kind: "messages" };
        patch(key, { running: false, executionId: null, run, output, tx: run.transaction });
        refreshExplorer(key, run);
      } catch (e) {
        if (stillCurrent()) patch(key, { running: false, executionId: null, error: String(e) });
      }
    },

    explain: async (key, sessionId, database, sql, analyze) => {
      patch(key, { explaining: true, explainError: null, output: { kind: "explain" } });
      try {
        const explain = await api.explainSql(sessionId, database, key, sql, analyze);
        patch(key, { explaining: false, explain });
      } catch (e) {
        patch(key, { explaining: false, explainError: String(e) });
      }
    },

    cancel: async (key) => {
      const executionId = get().consoles[key]?.executionId;
      if (!executionId) return;
      await api.cancelQuery(executionId);
    },

    setTxMode: async (key, sessionId, database, mode) => {
      const current = get().consoles[key] ?? blankSession;
      patch(key, { txMode: mode });
      // Leaving manual mode with work open asks the user first (in the UI);
      // here it just commits nothing and leaves the transaction to them.
      if (mode === "auto" && current.tx === "active") return;
      if (mode === "auto" && current.tx === "failed") {
        await get().endTransaction(key, sessionId, database, "ROLLBACK");
      }
    },

    endTransaction: async (key, sessionId, database, how) => {
      try {
        const run = await api.runSql(sessionId, database, key, how, null, 1, null);
        const error = run.results[0]?.error;
        patch(key, { tx: run.transaction, error: error ? error.message : null });
      } catch (e) {
        patch(key, { error: String(e) });
      }
    },
  };
});

// A tab's console goes when the tab does, including when a disconnect
// closes them all.
useSessionsStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return;
  const open = new Set(state.tabs.map((t) => t.id));
  const { consoles } = useConsoleStore.getState();
  const stale = Object.keys(consoles).filter((k) => !open.has(k));
  if (stale.length === 0) return;
  const kept = { ...consoles };
  for (const key of stale) delete kept[key];
  useConsoleStore.setState({ consoles: kept });
});
