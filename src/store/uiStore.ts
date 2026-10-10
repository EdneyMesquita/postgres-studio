import { create } from "zustand";
import { persist } from "zustand/middleware";

export type MainTab = "data" | "structure" | "sql";

/**
 * How query and script results are rendered: a document grid with the
 * selected document in an inspector beside it, a JSON tree, or raw JSON.
 */
export type ResultView = "grid" | "tree" | "json";

/** Which tool window the side panel shows, or null when it's hidden. */
export type SidePanel = "explorer" | "scripts" | null;

/** The connection dialog: a new connection, or editing a saved one. */
export type ConnectionDialog = { mode: "new" } | { mode: "edit"; id: string } | null;

/** The console's editor and output: side by side, or editor above output. */
export type ConsoleLayout = "side" | "stacked";

interface UiState {
  /** Each collection tab's view (Documents, Indexes, Console); unset is Documents. */
  mainTabs: Record<string, MainTab>;
  setMainTab: (tabId: string, view: MainTab) => void;
  resultView: ResultView;
  setResultView: (view: ResultView) => void;
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
  /** The inspector beside the document grid, in px. */
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
  connectionDialog: ConnectionDialog;
  setConnectionDialog: (dialog: ConnectionDialog) => void;
  /** The import / export connections dialog. */
  importExportOpen: boolean;
  setImportExportOpen: (open: boolean) => void;
  /** The Ctrl+K quick-open palette. */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

export const DEFAULT_CONSOLE_SPLIT = 0.6;
export const DEFAULT_SIDEBAR_WIDTH = 280;
export const DEFAULT_INSPECTOR_WIDTH = 380;

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      mainTabs: {},
      setMainTab: (tabId, view) => set((s) => ({ mainTabs: { ...s.mainTabs, [tabId]: view } })),
      resultView: "grid",
      setResultView: (view) => set({ resultView: view }),
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
      importExportOpen: false,
      setImportExportOpen: (open) => set({ importExportOpen: open }),
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
        resultView: s.resultView,
      }),
      version: 1,
      // Views from before the redesign: "table" became the grid.
      migrate: (state) => {
        const s = state as { resultView?: string };
        if (s.resultView !== "tree" && s.resultView !== "json") s.resultView = "grid";
        return s as never;
      },
    },
  ),
);
