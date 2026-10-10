import { useCallback, useSyncExternalStore } from "react";

/** Whether a media query matches, following the window as it resizes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      // some engines skip "change" under emulated or zoomed viewports
      window.addEventListener("resize", onChange);
      return () => {
        list.removeEventListener("change", onChange);
        window.removeEventListener("resize", onChange);
      };
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
