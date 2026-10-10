import { useRef } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { DEFAULT_ASSISTANT_WIDTH, useAssistantStore } from "../../store/assistantStore";
import { lockCursor, unlockCursor } from "../../lib/dragCursor";

export const MIN_ASSISTANT_WIDTH = 320;
export const MAX_ASSISTANT_WIDTH = 640;
const KEY_STEP = 16;

function clamp(width: number) {
  return Math.round(Math.min(MAX_ASSISTANT_WIDTH, Math.max(MIN_ASSISTANT_WIDTH, width)));
}

/** The Assistant's draggable left edge; dragging left widens it. */
export function AssistantResizer({ width }: { width: number }) {
  const setWidth = useAssistantStore((s) => s.setPanelWidth);
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
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
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
      aria-label="Resize Assistant"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={MIN_ASSISTANT_WIDTH}
      aria-valuemax={MAX_ASSISTANT_WIDTH}
      tabIndex={0}
      title="Drag to resize - double-click to reset"
      className="absolute inset-y-0 -left-[4px] z-20 w-[7px] cursor-col-resize transition-colors duration-150 hover:bg-accent/60 focus:outline-none focus-visible:bg-accent "
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => setWidth(DEFAULT_ASSISTANT_WIDTH)}
      onKeyDown={onKeyDown}
    />
  );
}
