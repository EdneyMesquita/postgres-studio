import { createPortal } from "react-dom";
import { useTabDragStore } from "./useTabDrag";

/** The dragged tab's name, following the pointer. */
export function TabDragGhost() {
  const drag = useTabDragStore();
  if (!drag.tabId) return null;
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-[100] rounded-md border border-line bg-panel px-2.5 py-1 text-sm text-fg shadow-overlay"
      style={{ left: drag.x + 12, top: drag.y + 10 }}
    >
      {drag.label}
    </div>,
    document.body,
  );
}
