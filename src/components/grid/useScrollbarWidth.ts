import { useEffect, useState } from "react";
import type { RefObject } from "react";

/** Width of an element's vertical scrollbar, 0 while it has none. */
export function useScrollbarWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.offsetWidth - el.clientWidth);
    measure();
    // the content box shrinks when a scrollbar appears, which this sees
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
