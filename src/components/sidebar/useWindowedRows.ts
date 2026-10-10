import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";
import { rowWindow, VIRTUALIZE_FROM } from "../grid/useVirtualRows";

/** Every explorer row is h-6. */
export const TREE_ROW_PX = 24;

/** Marks the element the explorer scrolls in. */
export const TREE_SCROLLER_ATTR = "data-tree-scroller";

export interface RowsWindow {
  start: number;
  /** Exclusive. */
  end: number;
  padTop: number;
  padBottom: number;
}

/**
 * Windowing for a long run of tree rows (a database's collections) inside
 * the explorer's scroller, which also holds every row above and below the
 * list: only the rows in view, plus a margin, are rendered, and spacers
 * keep the scrollbar true to the whole tree. Short lists render whole.
 */
export function useWindowedRows(list: RefObject<HTMLElement | null>, count: number): RowsWindow {
  const enabled = count > VIRTUALIZE_FROM;
  const [view, setView] = useState({ top: 0, height: 800 });

  useLayoutEffect(() => {
    const el = list.current;
    const scroller = el?.closest<HTMLElement>(`[${TREE_SCROLLER_ATTR}]`);
    if (!enabled || !el || !scroller) return;
    const measure = () => {
      // where the visible part of the scroller falls within the list
      const top = scroller.getBoundingClientRect().top - el.getBoundingClientRect().top;
      // snapped to a row, so scrolling within one doesn't re-render
      const row = Math.floor(Math.max(0, Math.min(top, count * TREE_ROW_PX)) / TREE_ROW_PX);
      const next = { top: row * TREE_ROW_PX, height: scroller.clientHeight };
      setView((v) => (v.top === next.top && v.height === next.height ? v : next));
    };
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    // rows opening or closing above the list move it
    const resize = new ResizeObserver(measure);
    resize.observe(scroller);
    if (scroller.firstElementChild) resize.observe(scroller.firstElementChild);
    return () => {
      scroller.removeEventListener("scroll", measure);
      resize.disconnect();
    };
  }, [list, enabled, count]);

  if (!enabled) return { start: 0, end: count, padTop: 0, padBottom: 0 };
  return rowWindow(count, TREE_ROW_PX, view, null);
}
