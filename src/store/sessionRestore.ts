import type { RelKind } from "../types/pg";
import { useConnectionsStore } from "./connectionsStore";
import { useConsoleStore } from "./consoleStore";
import { useEditorLayoutStore } from "./editorLayoutStore";
import { useScriptsStore, type ConsoleFile } from "./scriptsStore";
import { newTableTab, useSessionsStore, type Tab, type TabQueryFields } from "./sessionsStore";
import { useSettingsStore, type ConsoleEngine } from "./settingsStore";
import { useUiStore, type MainTab } from "./uiStore";

/**
 * "Reopen last session's tabs on launch": the open tabs are kept as they
 * change, and put back at the next launch as dormant tabs that connect -
 * and run their query - only when they're opened.
 */

const STORAGE_KEY = "postgres-studio-last-session";

/** What a console keeps: its SQL, the file it's saved to, its engine. */
interface SavedConsole {
  script: string | null;
  file: ConsoleFile | null;
  engine?: ConsoleEngine;
}

type SavedTab =
  | ({
      kind: "table";
      id: string;
      connectionId: string;
      database: string;
      schema: string;
      table: string;
      relkind: RelKind;
      view?: MainTab;
    } & TabQueryFields &
      SavedConsole)
  | ({ kind: "console"; id: string; connectionId: string; database: string; number: number } & SavedConsole)
  | { kind: "diagram"; id: string; connectionId: string; database: string; schema: string; focus: string | null }
  | { kind: "activity"; id: string; connectionId: string; database: string; view?: "sessions" | "locks" | "jobs" };

interface SavedSession {
  version: 1;
  activeTabId: string | null;
  tabs: SavedTab[];
}

function savedConsole(id: string): SavedConsole {
  const { consoles } = useConsoleStore.getState();
  const { files } = useScriptsStore.getState();
  const engine = useSettingsStore.getState().engineByTab[id];
  return { script: consoles[id]?.script ?? null, file: files[id] ?? null, ...(engine ? { engine } : {}) };
}

/** The open tabs as they are now. */
export function snapshot(): SavedSession {
  const { tabs, activeTabId } = useSessionsStore.getState();
  const { mainTabs } = useUiStore.getState();
  return {
    version: 1,
    activeTabId,
    tabs: tabs.map((t): SavedTab => {
      const base = { id: t.id, connectionId: t.connection.id, database: t.database };
      switch (t.kind) {
        case "table":
          return {
            kind: "table",
            ...base,
            schema: t.schema,
            table: t.table,
            relkind: t.relkind,
            view: mainTabs[t.id],
            whereText: t.whereText,
            orderByText: t.orderByText,
            limit: t.limit,
            offset: t.offset,
            ...savedConsole(t.id),
          };
        case "console":
          return { kind: "console", ...base, number: t.number, ...savedConsole(t.id) };
        case "diagram":
          return { kind: "diagram", ...base, schema: t.schema, focus: t.focus };
        case "activity":
          return { kind: "activity", ...base, view: t.view };
      }
    }),
  };
}

function read(): SavedSession | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as SavedSession | null;
    return value?.version === 1 && Array.isArray(value.tabs) ? value : null;
  } catch {
    return null;
  }
}

function write(session: SavedSession | null) {
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable: the tabs just won't come back
  }
}

/** The saved tabs, dormant, for the connections that still exist. */
export function restoredTabs(saved: SavedSession, profiles: { id: string; name: string; summary: string }[]) {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const tabs: Tab[] = [];
  const consoles: Record<string, SavedConsole> = {};
  const views: Record<string, MainTab> = {};
  for (const s of saved.tabs) {
    const p = byId.get(s.connectionId);
    if (!p) continue;
    const connection = { id: p.id, name: p.name, summary: p.summary };
    switch (s.kind) {
      case "table":
        tabs.push({
          ...newTableTab(connection, s.database, s.schema, s.table, s.relkind, s.whereText),
          // Its console and view are kept under this id.
          id: s.id,
          orderByText: s.orderByText,
          limit: s.limit,
          offset: s.offset,
          dormant: true,
        });
        if (s.view) views[s.id] = s.view;
        consoles[s.id] = s;
        break;
      case "console":
        tabs.push({ kind: "console", id: s.id, connection, database: s.database, number: s.number, dormant: true });
        consoles[s.id] = s;
        break;
      case "diagram":
        tabs.push({ kind: "diagram", id: s.id, connection, database: s.database, schema: s.schema, focus: s.focus, dormant: true });
        break;
      case "activity":
        tabs.push({ kind: "activity", id: s.id, connection, database: s.database, view: s.view, dormant: true });
        break;
    }
  }
  return { tabs, consoles, views };
}

/** Puts the saved tabs back, dormant. */
function restore() {
  const saved = read();
  if (!saved || !useSettingsStore.getState().reopenTabs) return;
  const { tabs, consoles, views } = restoredTabs(saved, useConnectionsStore.getState().profiles);
  if (tabs.length === 0) return;
  const files: Record<string, ConsoleFile> = {};
  for (const [id, c] of Object.entries(consoles)) {
    if (c.script !== null) useConsoleStore.getState().setScript(id, c.script);
    if (c.file) files[id] = c.file;
    if (c.engine) useSettingsStore.getState().setTabEngine(id, c.engine);
  }
  useScriptsStore.setState((st) => ({ files: { ...files, ...st.files } }));
  for (const [id, view] of Object.entries(views)) useUiStore.getState().setMainTab(id, view);
  useSessionsStore.getState().restoreTabs(tabs, saved.activeTabId);
}

/** The tabs on screen: the active one, and every pane's in a split. */
function shownTabIds(): string[] {
  const { activeTabId } = useSessionsStore.getState();
  const { panes } = useEditorLayoutStore.getState();
  return [...new Set([activeTabId, ...panes].filter((id): id is string => Boolean(id)))];
}

/**
 * Wakes the dormant tabs on screen: those whose connection is live run
 * now; the others start connecting, and run once it's up.
 */
function wakeShown() {
  const { tabs, wakeTab } = useSessionsStore.getState();
  const connections = useConnectionsStore.getState();
  for (const id of shownTabIds()) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab?.dormant) continue;
    const session = connections.sessions[tab.connection.id];
    if (session) void wakeTab(session.sessionId, tab.id);
    // A failed connect waits for Try again rather than looping.
    else if (!connections.connecting[tab.connection.id] && !connections.connectErrors[tab.connection.id]) {
      void connections.connect(tab.connection.id);
    }
  }
}

/** Connects a dormant tab's connection again after a failed try. */
export function retryDormantTab(connectionId: string) {
  void useConnectionsStore.getState().connect(connectionId);
}

let started = false;

/**
 * Restores the last session once the saved connections are known, then
 * keeps the open tabs saved and wakes dormant ones as they're opened.
 * Called once the app has mounted.
 */
export function startSessionRestore() {
  if (started) return;
  started = true;

  let restored = false;
  let pending: number | null = null;
  const save = () => {
    // Nothing is saved before the restore, which would overwrite it with no tabs.
    if (!restored) return;
    if (pending !== null) window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = null;
      write(useSettingsStore.getState().reopenTabs ? snapshot() : null);
    }, 300);
  };

  const begin = () => {
    if (restored) return;
    restored = true;
    restore();
    wakeShown();
    save();
  };
  if (useConnectionsStore.getState().profilesLoaded) begin();
  else {
    const stop = useConnectionsStore.subscribe((s) => {
      if (!s.profilesLoaded) return;
      stop();
      begin();
    });
  }

  useSessionsStore.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) save();
    if (s.activeTabId !== prev.activeTabId) {
      save();
      wakeShown();
    }
  });
  useEditorLayoutStore.subscribe((s, prev) => {
    if (s.panes !== prev.panes) wakeShown();
  });
  useConnectionsStore.subscribe((s, prev) => {
    if (s.sessions !== prev.sessions) wakeShown();
  });
  useConsoleStore.subscribe((s, prev) => {
    if (s.consoles !== prev.consoles) save();
  });
  useScriptsStore.subscribe((s, prev) => {
    if (s.files !== prev.files) save();
  });
  useUiStore.subscribe((s, prev) => {
    if (s.mainTabs !== prev.mainTabs) save();
  });
  useSettingsStore.subscribe((s, prev) => {
    if (s.reopenTabs !== prev.reopenTabs || s.engineByTab !== prev.engineByTab) save();
  });
}
