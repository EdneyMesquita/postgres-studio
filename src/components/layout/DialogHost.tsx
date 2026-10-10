import { lazy, Suspense } from "react";
import { useUiStore } from "../../store/uiStore";
import { ConfirmDialog } from "../common/ConfirmDialog";

// Loaded on first use, keeping them out of the startup bundle.
const ConnectionForm = lazy(() =>
  import("../connections/ConnectionForm").then((m) => ({ default: m.ConnectionForm })),
);
const ConnectionsImportExportDialog = lazy(() =>
  import("../connections/ConnectionsImportExportDialog").then((m) => ({
    default: m.ConnectionsImportExportDialog,
  })),
);
const EditConnectionDialog = lazy(() =>
  import("./EditConnectionDialog").then((m) => ({ default: m.EditConnectionDialog })),
);

/**
 * App-level dialogs, opened from anywhere through uiStore: the connection
 * form (for a new connection or a saved one) and import / export; and the
 * questions `confirm()` asks, above them.
 */
export function DialogHost() {
  const dialog = useUiStore((s) => s.connectionDialog);
  const setConnectionDialog = useUiStore((s) => s.setConnectionDialog);
  const importExportOpen = useUiStore((s) => s.importExportOpen);
  const setImportExportOpen = useUiStore((s) => s.setImportExportOpen);
  const close = () => setConnectionDialog(null);

  let content = null;
  if (dialog?.mode === "new") content = <ConnectionForm onSaved={close} onCancel={close} />;
  else if (dialog?.mode === "edit") {
    content = <EditConnectionDialog key={dialog.id} id={dialog.id} onClose={close} />;
  } else if (importExportOpen) {
    content = <ConnectionsImportExportDialog onClose={() => setImportExportOpen(false)} />;
  }
  return (
    <>
      <Suspense fallback={null}>{content}</Suspense>
      <ConfirmDialog />
    </>
  );
}
