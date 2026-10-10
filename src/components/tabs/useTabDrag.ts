import { create } from "zustand";
import type { PointerEvent as ReactPointerEvent } from "react";
import { lockCursor, unlockCursor } from "../../lib/dragCursor";
import { useEditorLayoutStore } from "../../store/editorLayoutStore";
import { useTabGroupsStore } from "../../store/tabGroupsStore";

/** Where a dragged tab would land. */
export type TabDropTarget =
  | { kind: "pane"; pane: number }
  /** The right half of a single view: splits it. */
  | { kind: "side" }
  /** A group's header; a connection group takes the tab out of its manual group. */
  | { kind: "group"; groupId: string; manual: boolean };

interface TabDragState {
  tabId: string | null;
  label: string;
  x: number;
  y: number;
  target: TabDropTarget | null;
}

/** The tab being dragged, for the ghost and the drop highlights. */
export const useTabDragStore = create<TabDragState>(() => ({
  tabId: null,
  label: "",
  x: 0,
  y: 0,
  target: null,
}));

/** Pointer travel before a press on a tab becomes a drag rather than a click. */
const DRAG_THRESHOLD = 5;

/**
 * The drop target under the pointer. Panes carry `data-drop-pane`, the
 * split zone `data-drop-side`, group headers `data-drop-group` (and
 * `data-drop-manual` for the user's groups).
 */
function targetAt(x: number, y: number): TabDropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-pane], [data-drop-side], [data-drop-group]");
  if (!el) return null;
  if (el.dataset.dropPane !== undefined) return { kind: "pane", pane: Number(el.dataset.dropPane) };
  if (el.dataset.dropSide !== undefined) return { kind: "side" };
  return { kind: "group", groupId: el.dataset.dropGroup!, manual: el.dataset.dropManual !== undefined };
}

function drop(tabId: string, target: TabDropTarget) {
  const layout = useEditorLayoutStore.getState();
  if (target.kind === "pane") layout.openInPane(tabId, target.pane);
  else if (target.kind === "side") layout.openToSide(tabId);
  else useTabGroupsStore.getState().moveToGroup(tabId, target.manual ? target.groupId : null);
}

/**
 * Starts tracking a press on a tab; past a few pixels it becomes a drag
 * onto a pane, the split zone or a group header. Pointer events rather than
 * HTML5 drag and drop, as in the sidebar: Tauri's file-drop handling
 * swallows HTML5 drags in the Windows webview.
 */
export function startTabDrag(e: ReactPointerEvent<HTMLElement>, tabId: string, label: string) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("[data-no-drag]")) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;

  function onMove(ev: PointerEvent) {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      dragging = true;
      lockCursor("grabbing");
    }
    useTabDragStore.setState({ tabId, label, x: ev.clientX, y: ev.clientY, target: targetAt(ev.clientX, ev.clientY) });
  }

  function finish(ev: PointerEvent, cancelled: boolean) {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    if (!dragging) return;
    unlockCursor();
    const target = cancelled ? null : targetAt(ev.clientX, ev.clientY);
    useTabDragStore.setState({ tabId: null, target: null });
    // A drop back on the tab ends with a click on it, which a drag isn't.
    // That click comes right after pointerup or not at all, so the guard
    // doesn't wait for a later, real click.
    const swallow = (c: MouseEvent) => c.stopPropagation();
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (target) drop(tabId, target);
  }
  const onUp = (ev: PointerEvent) => finish(ev, false);
  const onCancel = (ev: PointerEvent) => finish(ev, true);
  function onKey(ev: KeyboardEvent) {
    if (ev.key !== "Escape" || !dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(new PointerEvent("pointercancel"), true);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
}
