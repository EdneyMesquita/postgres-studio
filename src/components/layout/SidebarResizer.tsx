import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { DEFAULT_SIDEBAR_WIDTH, useUiStore } from "../../store/uiStore";
import { lockCursor, unlockCursor } from "../../lib/dragCursor";

const MIN_WIDTH = 180;
const KEY_STEP = 16;

/** Widest the sidebar may get: most of the window, so the main area never vanishes. */
function maxWidth() {
  return Math.max(MIN_WIDTH, Math.min(720, window.innerWidth * 0.6));
}

export function clampSidebarWidth(width: number) {
  return Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, width)));
}

/** The draggable right edge of the side panel. */
export function SidebarResizer() {
  const width = useUiStore((s) => s.sidebarWidth);
  const setWidth = useUiStore((s) => s.setSidebarWidth);
  // Width at press time and pointer offset, so the edge tracks the pointer
  // from wherever it was grabbed.
  const start = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setDragging(true);
    document.body.style.userSelect = "none";
    lockCursor("col-resize");
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!start.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setWidth(clampSidebarWidth(start.current.width + e.clientX - start.current.x));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    start.current = null;
    setDragging(false);
    document.body.style.userSelect = "";
    unlockCursor();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      // Held keys fire faster than re-renders; step from the stored width,
      // not this render's, or repeats would all land on the same value.
      const current = useUiStore.getState().sidebarWidth;
      setWidth(clampSidebarWidth(current + (e.key === "ArrowRight" ? KEY_STEP : -KEY_STEP)));
    }
  }

  return (
    <div
      role="separator"
      aria-label="Resize side panel"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      tabIndex={0}
      title="Drag to resize - double-click to reset"
      data-dragging={dragging || undefined}
      // A 6px grab area straddling the panel's border; a 2px accent line
      // shows on hover, keyboard focus and while dragging.
      className="absolute inset-y-0 -right-[3px] z-20 w-1.5 cursor-col-resize focus:outline-none after:absolute after:inset-y-0 after:left-0.5 after:w-0.5 after:bg-accent after:opacity-0 after:transition-opacity after:duration-150 hover:after:opacity-100 focus-visible:after:opacity-100 data-dragging:after:opacity-100"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setWidth(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={onKeyDown}
    />
  );
}
