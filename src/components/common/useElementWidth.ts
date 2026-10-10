import { useCallback, useState } from "react";

/**
 * An element's width, followed as it resizes - the editor narrows when the
 * Assistant opens, not only when the window does. Pass the ref callback to
 * the element; 0 until measured.
 */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((el: T | null) => {
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
