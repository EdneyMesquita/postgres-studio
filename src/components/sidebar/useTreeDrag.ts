import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { canMove, findFolder, locate } from "../../lib/sidebarTree";
import type { DropTarget, TreeNode } from "../../lib/sidebarTree";
import { lockCursor, unlockCursor } from "../../lib/dragCursor";

/** Where a drop would land, relative to the row under the pointer. */
export interface DropIndicator {
  /** The row pointed at; null for the empty space at the end of the list. */
  nodeId: string | null;
  position: "before" | "after" | "inside" | "end";
}

export interface DragState {
  nodeId: string;
  label: string;
  x: number;
  y: number;
  indicator: DropIndicator | null;
}

/** Pointer travel before a press on a row becomes a drag rather than a click. */
const DRAG_THRESHOLD = 5;

/**
 * The drop position an indicator stands for, or null where the node can't
 * go (a folder into itself or its own subfolders).
 */
export function dropTargetFor(
  root: TreeNode[],
  nodeId: string,
  indicator: DropIndicator,
): DropTarget | null {
  let target: DropTarget | null = null;
  if (indicator.position === "end" || indicator.nodeId === null) {
    target = { parentId: null, index: root.length };
  } else if (indicator.position === "inside") {
    const folder = findFolder(root, indicator.nodeId);
    target = folder ? { parentId: folder.id, index: folder.children.length } : null;
  } else {
    const found = locate(root, indicator.nodeId);
    if (found) {
      target = {
        parentId: found.parentId,
        index: indicator.position === "before" ? found.index : found.index + 1,
      };
    }
  }
  return target && canMove(root, nodeId, target) ? target : null;
}

/**
 * Drag-to-rearrange for the connection tree, on pointer events rather than
 * HTML5 drag and drop: Tauri's file-drop handling swallows HTML5 drags in
 * the Windows webview, and pointer events behave the same everywhere.
 *
 * Rows carry `data-node-id` and `data-node-type`; the list carries
 * `data-tree-root`, and anything marked `data-no-drag` (buttons, inputs)
 * never starts a drag.
 */
export function useTreeDrag(
  getRoot: () => TreeNode[],
  onDrop: (nodeId: string, target: DropTarget) => void,
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pending = useRef<{ nodeId: string; label: string; x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const finish = useCallback(() => {
    pending.current = null;
    setDrag(null);
    document.body.style.userSelect = "";
    unlockCursor();
  }, []);

  useEffect(() => {
    function indicatorAt(x: number, y: number, nodeId: string): DropIndicator | null {
      const el = document.elementFromPoint(x, y);
      const row = el?.closest<HTMLElement>("[data-node-id]");
      if (row) {
        const id = row.dataset.nodeId!;
        if (id === nodeId) return null;
        const rect = row.getBoundingClientRect();
        const rel = (y - rect.top) / rect.height;
        if (row.dataset.nodeType === "folder") {
          if (rel < 0.25) return { nodeId: id, position: "before" };
          // below an open folder's row come its children: dropping there
          // means "first thing inside", not "after the whole folder"
          if (rel > 0.75 && row.dataset.collapsed === "true") {
            return { nodeId: id, position: "after" };
          }
          return { nodeId: id, position: "inside" };
        }
        return { nodeId: id, position: rel < 0.5 ? "before" : "after" };
      }
      if (el?.closest("[data-tree-root]")) return { nodeId: null, position: "end" };
      return null;
    }

    function onMove(e: PointerEvent) {
      const start = pending.current;
      if (!start) return;
      if (!dragRef.current && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) {
        return;
      }
      document.body.style.userSelect = "none";
      lockCursor("grabbing");
      let indicator = indicatorAt(e.clientX, e.clientY, start.nodeId);
      if (indicator && !dropTargetFor(getRoot(), start.nodeId, indicator)) indicator = null;
      setDrag({ nodeId: start.nodeId, label: start.label, x: e.clientX, y: e.clientY, indicator });
    }

    function onUp() {
      const current = dragRef.current;
      if (current) {
        const target = current.indicator && dropTargetFor(getRoot(), current.nodeId, current.indicator);
        if (target) onDrop(current.nodeId, target);
        // The release also fires a click on the row it started on, which
        // would connect or toggle it; swallow that one click. It arrives in
        // this same task, so drop the listener right after: if no click
        // comes (released elsewhere), it mustn't eat the user's next one.
        const swallow = (e: MouseEvent) => {
          e.stopPropagation();
          e.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      }
      finish();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && dragRef.current) finish();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [getRoot, onDrop, finish]);

  const startPress = useCallback((e: ReactPointerEvent, nodeId: string, label: string) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest("[data-no-drag]")) return;
    pending.current = { nodeId, label, x: e.clientX, y: e.clientY };
  }, []);

  return { drag, startPress };
}
