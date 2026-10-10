import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { DEFAULT_INSPECTOR_WIDTH, useUiStore } from "../../store/uiStore";
import { lockCursor, unlockCursor } from "../../lib/dragCursor";

export const MIN_INSPECTOR_WIDTH = 280;
export const MAX_INSPECTOR_WIDTH = 640;
const KEY_STEP = 16;

function clamp(width: number) {
  return Math.round(Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, width)));
}

/** The draggable left edge of the inspector; dragging left widens it. */
export function InspectorResizer({ width }: { width: number }) {
  const setWidth = useUiStore((s) => s.setInspectorWidth);
  // Width at press time and pointer offset, so the edge tracks the pointer
  // from wherever it was grabbed.
  const start = useRef<{ x: number; width: number } | null>(null);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    document.body.style.userSelect = "none";
    lockCursor("col-resize");
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!start.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setWidth(clamp(start.current.width - (e.clientX - start.current.x)));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    start.current = null;
    document.body.style.userSelect = "";
    unlockCursor();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setWidth(clamp(width + (e.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP)));
  }

  return (
    <div
      role="separator"
      aria-label="Resize row panel"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={MIN_INSPECTOR_WIDTH}
      aria-valuemax={MAX_INSPECTOR_WIDTH}
      tabIndex={0}
      title="Drag to resize - double-click to reset"
      // A 7px grab area straddling the inspector's border.
      className="absolute inset-y-0 -left-[4px] z-20 w-[7px] cursor-col-resize transition-colors duration-150 hover:bg-accent/60 focus:outline-none focus-visible:bg-accent"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setWidth(DEFAULT_INSPECTOR_WIDTH)}
      onKeyDown={onKeyDown}
    />
  );
}
