import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Choices for the rows a new table tab asks for. */
export const PAGE_SIZES = [50, 100, 200, 500, 1000] as const;

/** Choices for the rows a console keeps of each result. */
export const CONSOLE_ROW_LIMITS = [500, 1000, 5000, 10000] as const;

/** Which engine runs a console's SQL. */
export type ConsoleEngine = "builtin" | "psql";

/** How psql is started, see Settings › Console. */
export interface PsqlSettings {
  /** An executable picked by hand; null uses the one found. */
  path: string | null;
  extraArgs: string;
  loadRc: boolean;
  /** Stops a run that takes longer; null waits as long as it takes. */
  timeoutSecs: number | null;
}

/** Choices for psql's time limit, in seconds; null is none. */
export const PSQL_TIMEOUTS: { value: number | null; label: string }[] = [
  { value: 60, label: "1 minute" },
  { value: 600, label: "10 minutes" },
  { value: 3600, label: "1 hour" },
  { value: null, label: "No limit" },
];

interface SettingsState {
  /** The limit a new table tab starts with. */
  pageSize: number;
  setPageSize: (size: number) => void;
  /** How many rows of each result a console keeps; a result with more says so. */
  consoleRowLimit: number;
  setConsoleRowLimit: (limit: number) => void;

  /** The engine new consoles start with. */
  consoleEngine: ConsoleEngine;
  setConsoleEngine: (engine: ConsoleEngine) => void;
  /** A console switched from its toolbar, by tab id. */
  engineByTab: Record<string, ConsoleEngine>;
  setTabEngine: (tabId: string, engine: ConsoleEngine) => void;
  forgetTabEngine: (tabId: string) => void;
  psql: PsqlSettings;
  setPsql: (patch: Partial<PsqlSettings>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      pageSize: 100,
      setPageSize: (pageSize) => set({ pageSize }),
      consoleRowLimit: 1000,
      setConsoleRowLimit: (consoleRowLimit) => set({ consoleRowLimit }),

      consoleEngine: "builtin",
      setConsoleEngine: (consoleEngine) => set({ consoleEngine }),
      engineByTab: {},
      setTabEngine: (tabId, engine) => set((s) => ({ engineByTab: { ...s.engineByTab, [tabId]: engine } })),
      forgetTabEngine: (tabId) =>
        set((s) => {
          if (!(tabId in s.engineByTab)) return s;
          const engineByTab = { ...s.engineByTab };
          delete engineByTab[tabId];
          return { engineByTab };
        }),
      psql: { path: null, extraArgs: "", loadRc: true, timeoutSecs: 600 },
      setPsql: (patch) => set((s) => ({ psql: { ...s.psql, ...patch } })),
    }),
    {
      name: "postgres-studio-settings",
      version: 1,
      partialize: (s) => ({
        pageSize: s.pageSize,
        consoleRowLimit: s.consoleRowLimit,
        consoleEngine: s.consoleEngine,
        psql: s.psql,
      }),
      // Settings added later get their defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return { ...current, ...p, psql: { ...current.psql, ...p.psql } };
      },
    },
  ),
);

/** The engine a console runs with, read now (for callbacks). */
export function engineFor(tabId: string): ConsoleEngine {
  const s = useSettingsStore.getState();
  return s.engineByTab[tabId] ?? s.consoleEngine;
}

/** The engine a console runs with: its own, or the default. */
export function useTabEngine(tabId: string): ConsoleEngine {
  return useSettingsStore((s) => s.engineByTab[tabId] ?? s.consoleEngine);
}
