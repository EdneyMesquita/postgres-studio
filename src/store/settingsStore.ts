import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { McpCapability, McpLevel, McpPolicy } from "../types/mcp";

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

/** The MCP server's settings, pushed to the backend as they change. */
export interface McpSettings {
  enabled: boolean;
  port: number;
  caps: Record<Exclude<McpCapability, "browse">, McpPolicy>;
  /** Per saved connection id; one missing here has no access. */
  connections: Record<string, McpLevel>;
  /** Capabilities answered "Always allow here", per connection id. */
  always: Record<string, McpCapability[]>;
}

export const DEFAULT_MCP_PORT = 47432;

export const DEFAULT_MCP_CAPS: McpSettings["caps"] = {
  read: "allow",
  write: "ask",
  ddl: "ask",
  script: "off",
  connList: "allow",
  connEdit: "ask",
  connDelete: "off",
  saveScript: "allow",
};

interface SettingsState {
  /** Put the last session's tabs back on launch, dormant until opened. */
  reopenTabs: boolean;
  setReopenTabs: (on: boolean) => void;
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

  mcp: McpSettings;
  setMcp: (patch: Partial<McpSettings>) => void;
  setMcpCap: (cap: keyof McpSettings["caps"], policy: McpPolicy) => void;
  setMcpLevels: (connectionIds: string[], level: McpLevel) => void;
  addMcpAlways: (connectionId: string, cap: McpCapability) => void;
  removeMcpAlways: (connectionId: string, cap: McpCapability) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      reopenTabs: true,
      setReopenTabs: (reopenTabs) => set({ reopenTabs }),
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

      mcp: {
        enabled: false,
        port: DEFAULT_MCP_PORT,
        caps: DEFAULT_MCP_CAPS,
        connections: {},
        always: {},
      },
      setMcp: (patch) => set((s) => ({ mcp: { ...s.mcp, ...patch } })),
      setMcpCap: (cap, policy) => set((s) => ({ mcp: { ...s.mcp, caps: { ...s.mcp.caps, [cap]: policy } } })),
      setMcpLevels: (ids, level) =>
        set((s) => {
          const connections = { ...s.mcp.connections };
          for (const id of ids) connections[id] = level;
          return { mcp: { ...s.mcp, connections } };
        }),
      addMcpAlways: (connectionId, cap) =>
        set((s) => {
          const caps = s.mcp.always[connectionId] ?? [];
          if (caps.includes(cap)) return s;
          return { mcp: { ...s.mcp, always: { ...s.mcp.always, [connectionId]: [...caps, cap] } } };
        }),
      removeMcpAlways: (connectionId, cap) =>
        set((s) => {
          const caps = (s.mcp.always[connectionId] ?? []).filter((c) => c !== cap);
          const always = { ...s.mcp.always };
          if (caps.length) always[connectionId] = caps;
          else delete always[connectionId];
          return { mcp: { ...s.mcp, always } };
        }),
    }),
    {
      name: "postgres-studio-settings",
      version: 1,
      partialize: (s) => ({
        reopenTabs: s.reopenTabs,
        pageSize: s.pageSize,
        consoleRowLimit: s.consoleRowLimit,
        consoleEngine: s.consoleEngine,
        psql: s.psql,
        mcp: s.mcp,
      }),
      // Settings and capabilities added later get their defaults.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...p,
          psql: { ...current.psql, ...p.psql },
          mcp: { ...current.mcp, ...p.mcp, caps: { ...DEFAULT_MCP_CAPS, ...p.mcp?.caps } },
        };
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
