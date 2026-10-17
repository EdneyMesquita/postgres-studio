import { create } from "zustand";
import { persist } from "zustand/middleware";

export type MainTab = "data" | "structure" | "sql";

/** Which tool window the side panel shows, or null when it's hidden. */
export type SidePanel = "explorer" | "scripts" | null;

/** The connection dialog: a new connection, or editing a saved one. */
export type ConnectionDialog = { mode: "new" } | { mode: "edit"; id: string } | null;

/** The import / export dialog: which side, and the connections an export starts with. */
export type TransferDialog = { tab: "export" | "import"; ids: string[] | null };

/** The console's editor and output: side by side, or editor above output. */
export type ConsoleLayout = "side" | "stacked";

interface UiState {
  /** Each table tab's view (Data, Structure, SQL); unset is Data. */
  mainTabs: Record<string, MainTab>;
  setMainTab: (tabId: string, view: MainTab) => void;
  consoleLayout: ConsoleLayout;
  setConsoleLayout: (layout: ConsoleLayout) => void;
  /** The editor's share of the console, remembered per layout. */
  consoleSplit: Record<ConsoleLayout, number>;
  setConsoleSplit: (layout: ConsoleLayout, ratio: number) => void;
  /** Sidebar width in px. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  sidePanel: SidePanel;
  /** Shows a tool window; showing the one already open hides the panel. */
  toggleSidePanel: (panel: Exclude<SidePanel, null>) => void;
  setSidePanel: (panel: SidePanel) => void;
  /** The row inspector beside the grid, in px. */
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
  connectionDialog: ConnectionDialog;
  setConnectionDialog: (dialog: ConnectionDialog) => void;
  /** The import / export connections dialog. */
  transfer: TransferDialog | null;
  /** Opens it on `tab`; an export starts with `ids` ticked (all when null). */
  openTransfer: (tab: TransferDialog["tab"], ids?: string[] | null) => void;
  closeTransfer: () => void;
  /** The Ctrl+K quick-open palette. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

/**
 * Saved UI state from an older version. Results only ever show as a grid:
 * the result view version 1 kept (and nothing read) is dropped.
 */
export function migrateUi(state: unknown): Record<string, unknown> {
  const s = { ...(state as Record<string, unknown>) };
  delete s.resultView;
  return s;
}

export const DEFAULT_CONSOLE_SPLIT = 0.6;
export const DEFAULT_SIDEBAR_WIDTH = 280;
export const DEFAULT_INSPECTOR_WIDTH = 380;

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      mainTabs: {},
      setMainTab: (tabId, view) => set((s) => ({ mainTabs: { ...s.mainTabs, [tabId]: view } })),
      consoleLayout: "stacked",
      setConsoleLayout: (layout) => set({ consoleLayout: layout }),
      consoleSplit: { side: DEFAULT_CONSOLE_SPLIT, stacked: DEFAULT_CONSOLE_SPLIT },
      setConsoleSplit: (layout, ratio) =>
        set((s) => ({ consoleSplit: { ...s.consoleSplit, [layout]: ratio } })),
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      sidePanel: "explorer",
      toggleSidePanel: (panel) => set((s) => ({ sidePanel: s.sidePanel === panel ? null : panel })),
      setSidePanel: (panel) => set({ sidePanel: panel }),
      inspectorWidth: DEFAULT_INSPECTOR_WIDTH,
      setInspectorWidth: (width) => set({ inspectorWidth: width }),
      connectionDialog: null,
      setConnectionDialog: (dialog) => set({ connectionDialog: dialog }),
      transfer: null,
      openTransfer: (tab, ids = null) => set({ transfer: { tab, ids } }),
      closeTransfer: () => set({ transfer: null }),
      paletteOpen: false,
      setPaletteOpen: (open) => set({ paletteOpen: open }),
    }),
    {
      name: "postgres-studio-ui",
      // Only layout sizes are lasting preferences; which tab is open resets
      // on launch as it always has.
      partialize: (s) => ({
        consoleLayout: s.consoleLayout,
        consoleSplit: s.consoleSplit,
        sidebarWidth: s.sidebarWidth,
        inspectorWidth: s.inspectorWidth,
      }),
      version: 2,
      migrate: (state) => migrateUi(state) as never,
    },
  ),
);
