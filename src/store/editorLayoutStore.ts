import { create } from "zustand";
import {
  closePane,
  focusedTab,
  isSplit,
  openInPane,
  openToSide,
  pruneTabs,
  showTab,
  SINGLE,
  withLayout,
  type EditorLayout,
  type SplitLayout,
} from "../lib/editorLayout";
import { useSessionsStore } from "./sessionsStore";

interface EditorLayoutState extends EditorLayout {
  setLayout: (layout: SplitLayout) => void;
  /** A click on a tab: its pane gets focus, or it opens in the focused one. */
  showTab: (tabId: string) => void;
  focusPane: (pane: number) => void;
  openInPane: (tabId: string, pane: number) => void;
  /** False when all four panes are taken. */
  openToSide: (tabId: string) => boolean;
  closePane: (pane: number) => void;
  toggleMaximize: (pane: number) => void;
}

const sessions = () => useSessionsStore.getState();

/**
 * The editor's panes. The sessions store keeps which tab is active; in a
 * split that's the focused pane's tab, so anything that activates a tab -
 * the sidebar, Ctrl+K, the Assistant - lands it in the focused pane.
 */
export const useEditorLayoutStore = create<EditorLayoutState>((set, get) => {
  const layout = (): EditorLayout => {
    const { layout, panes, focused, maximized } = get();
    return { layout, panes, focused, maximized };
  };

  /** Applies a layout and activates the focused pane's tab, if it has one. */
  function apply(next: EditorLayout, activate: string | null = focusedTab(next)) {
    set(next);
    if (activate && sessions().activeTabId !== activate) sessions().activateTab(activate);
  }

  return {
    ...SINGLE,

    setLayout: (kind) => {
      const active = sessions().activeTabId;
      if (kind === "single") {
        // The focused pane's tab carries on alone.
        apply(SINGLE, focusedTab(layout()) ?? active);
        return;
      }
      apply(withLayout(layout(), kind, active));
    },

    showTab: (tabId) => {
      apply(showTab(layout(), tabId), tabId);
    },

    focusPane: (pane) => {
      const state = layout();
      if (!isSplit(state) || pane === state.focused) return;
      apply({ ...state, focused: pane });
    },

    openInPane: (tabId, pane) => apply(openInPane(layout(), tabId, pane, sessions().activeTabId), tabId),

    openToSide: (tabId) => {
      const next = openToSide(layout(), tabId, sessions().activeTabId);
      if (!next) return false;
      apply(next);
      return true;
    },

    closePane: (pane) => {
      const state = layout();
      const next = closePane(state, pane);
      // Back to one pane: the tab left standing becomes the active one.
      const survivor = isSplit(next) ? focusedTab(next) : state.panes.find((p, i) => i !== pane && p !== null) ?? null;
      apply(next, survivor);
    },

    toggleMaximize: (pane) => {
      const state = layout();
      if (!isSplit(state)) return;
      apply({ ...state, focused: pane, maximized: state.maximized === null ? pane : null });
    },
  };
});

// Keeps the panes in step with the tabs: closed tabs leave their panes, and
// a tab activated anywhere shows in the focused pane.
useSessionsStore.subscribe((state, prev) => {
  const store = useEditorLayoutStore.getState();
  if (state.tabs !== prev.tabs) {
    const pruned = pruneTabs(store, new Set(state.tabs.map((t) => t.id)));
    if (pruned !== store) useEditorLayoutStore.setState(pruned);
  }
  if (state.activeTabId !== prev.activeTabId && state.activeTabId) {
    const current = useEditorLayoutStore.getState();
    const next = showTab(current, state.activeTabId);
    if (next !== current) useEditorLayoutStore.setState(next);
  }
});
