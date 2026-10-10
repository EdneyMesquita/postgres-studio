import { lazy, Suspense } from "react";
import { useObjectDialogsStore } from "../../store/objectDialogsStore";

// Loaded on first use, keeping them out of the startup bundle.
const ManageExtensionsDialog = lazy(() =>
  import("./ManageExtensionsDialog").then((m) => ({ default: m.ManageExtensionsDialog })),
);

/** The dialogs of the object tools that are open. */
export function ObjectDialogs() {
  const extensions = useObjectDialogsStore((s) => s.extensions);
  const closeExtensions = useObjectDialogsStore((s) => s.closeExtensions);
  return (
    <Suspense fallback={null}>
      {extensions && <ManageExtensionsDialog target={extensions} onClose={closeExtensions} />}
    </Suspense>
  );
}
