/**
 * How the editor splits into panes. One tab strip serves every pane: a tab
 * opens in the focused pane, and a tab already in a pane focuses it. Pure -
 * every operation returns a new layout; the store applies them.
 */

export type SplitLayout = "single" | "cols2" | "cols3" | "grid";

export interface SplitLayoutInfo {
  panes: number;
  cols: number;
  rows: number;
  label: string;
}

export const SPLIT_LAYOUTS: Record<SplitLayout, SplitLayoutInfo> = {
  single: { panes: 1, cols: 1, rows: 1, label: "Single" },
  cols2: { panes: 2, cols: 2, rows: 1, label: "2 columns" },
  cols3: { panes: 3, cols: 3, rows: 1, label: "3 columns" },
  grid: { panes: 4, cols: 2, rows: 2, label: "Grid 2 × 2" },
};

/** In order, so a layout's position is its Ctrl+Alt number minus one. */
export const SPLIT_LAYOUT_ORDER: SplitLayout[] = ["single", "cols2", "cols3", "grid"];

/** The most panes the editor splits into: beyond four the query bar and grid don't fit. */
export const MAX_PANES = 4;

export interface EditorLayout {
  layout: SplitLayout;
  /** The tab in each pane, or null for an empty one; [] when not split. */
  panes: (string | null)[];
  /** The pane a clicked tab opens in. */
  focused: number;
  /** A pane shown alone for a moment, the split kept behind it. */
  maximized: number | null;
}

export const SINGLE: EditorLayout = { layout: "single", panes: [], focused: 0, maximized: null };

export const isSplit = (state: EditorLayout) => state.layout !== "single";

/** The pane holding the tab, or -1. */
export const paneOf = (state: EditorLayout, tabId: string) =>
  isSplit(state) ? state.panes.indexOf(tabId) : -1;

function layoutFor(panes: number): SplitLayout {
  return SPLIT_LAYOUT_ORDER[Math.min(Math.max(panes, 1), MAX_PANES) - 1];
}

/**
 * Switches layout, keeping what the panes hold where it still fits. Going
 * from one pane to several, the active tab becomes the first pane's.
 */
export function withLayout(state: EditorLayout, layout: SplitLayout, activeTabId: string | null): EditorLayout {
  if (layout === "single") return SINGLE;
  const count = SPLIT_LAYOUTS[layout].panes;
  const panes = (isSplit(state) ? state.panes : [activeTabId]).slice(0, count);
  while (panes.length < count) panes.push(null);
  return { layout, panes, focused: Math.min(state.focused, count - 1), maximized: null };
}

/** Shows a tab: focuses the pane holding it, or puts it in the focused pane. */
export function showTab(state: EditorLayout, tabId: string): EditorLayout {
  if (!isSplit(state)) return state;
  const at = state.panes.indexOf(tabId);
  if (at >= 0) return at === state.focused ? state : { ...state, focused: at, maximized: state.maximized === null ? null : at };
  const panes = [...state.panes];
  panes[state.focused] = tabId;
  return { ...state, panes };
}

/** Puts a tab in a pane (moving it out of another), splitting first if needed. */
export function openInPane(state: EditorLayout, tabId: string, pane: number, activeTabId: string | null): EditorLayout {
  const split = isSplit(state) ? state : withLayout(state, "cols2", activeTabId);
  if (pane < 0 || pane >= split.panes.length) return split;
  const panes = split.panes.map((p) => (p === tabId ? null : p));
  panes[pane] = tabId;
  return { ...split, panes, focused: pane, maximized: null };
}

/**
 * Opens a tab beside the others: in an empty pane, or in a new one while
 * fewer than four. Null when all four panes are taken.
 */
export function openToSide(state: EditorLayout, tabId: string, activeTabId: string | null): EditorLayout | null {
  if (!isSplit(state)) {
    // Beside itself is no split at all: the other pane starts empty.
    const base = withLayout(state, "cols2", activeTabId);
    return activeTabId === tabId ? { ...base, focused: 1 } : openInPane(base, tabId, 1, activeTabId);
  }
  const empty = state.panes.indexOf(null);
  if (empty >= 0) return openInPane(state, tabId, empty, activeTabId);
  if (state.panes.length >= MAX_PANES) return null;
  const grown = withLayout(state, layoutFor(state.panes.length + 1), activeTabId);
  return openInPane(grown, tabId, grown.panes.length - 1, activeTabId);
}

/** Closes a pane; the layout shrinks to fit, back to a single pane at one. */
export function closePane(state: EditorLayout, pane: number): EditorLayout {
  if (!isSplit(state)) return state;
  const panes = state.panes.filter((_, i) => i !== pane);
  if (panes.length <= 1) return SINGLE;
  return {
    layout: layoutFor(panes.length),
    panes,
    focused: Math.min(state.focused > pane ? state.focused - 1 : state.focused, panes.length - 1),
    maximized: null,
  };
}

/** Empties the panes of tabs that were closed; a split with nothing left goes single. */
export function pruneTabs(state: EditorLayout, open: ReadonlySet<string>): EditorLayout {
  if (!isSplit(state)) return state;
  if (state.panes.every((p) => p === null || open.has(p))) return state;
  const panes = state.panes.map((p) => (p !== null && open.has(p) ? p : null));
  if (panes.every((p) => p === null) && open.size === 0) return SINGLE;
  return { ...state, panes };
}

/** The tab a single view shows when leaving a split: the focused pane's. */
export function focusedTab(state: EditorLayout): string | null {
  return isSplit(state) ? (state.panes[state.focused] ?? null) : null;
}
