import { lazy, Suspense, useState } from "react";
import { useUiStore } from "../../store/uiStore";

const QuickOpenPalette = lazy(() =>
  import("./QuickOpenPalette").then((m) => ({ default: m.QuickOpenPalette })),
);

/**
 * The quick-open palette, loaded the first time it opens (Ctrl+K or the
 * toolbar search) and kept mounted after, so later openings are instant.
 */
export function LazyQuickOpenPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const [wanted, setWanted] = useState(false);
  if (open && !wanted) setWanted(true);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <QuickOpenPalette />
    </Suspense>
  );
}
