import { lazy, Suspense } from "react";
import { useDumpStore } from "../../store/dumpStore";
import { useUiStore } from "../../store/uiStore";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { ObjectDialogs } from "../objects/ObjectDialogs";
import { TransferDialogs } from "../scripts/TransferDialogs";

// Loaded on first use, keeping them out of the startup bundle.
const ConnectionForm = lazy(() =>
  import("../connections/ConnectionForm").then((m) => ({ default: m.ConnectionForm })),
);
const ConnectionsImportExportDialog = lazy(() =>
  import("../connections/ConnectionsImportExportDialog").then((m) => ({
    default: m.ConnectionsImportExportDialog,
  })),
);
const BackupDialog = lazy(() => import("../dump/BackupDialog").then((m) => ({ default: m.BackupDialog })));
const RestoreDialog = lazy(() => import("../dump/RestoreDialog").then((m) => ({ default: m.RestoreDialog })));
const EditConnectionDialog = lazy(() =>
  import("./EditConnectionDialog").then((m) => ({ default: m.EditConnectionDialog })),
);

/**
 * App-level dialogs, opened from anywhere through uiStore: the connection
 * form (for a new connection or a saved one), import / export and backup /
 * restore; and the
 * questions `confirm()` asks, above them.
 */
export function DialogHost() {
  const dialog = useUiStore((s) => s.connectionDialog);
  const setConnectionDialog = useUiStore((s) => s.setConnectionDialog);
  const importExportOpen = useUiStore((s) => s.importExportOpen);
  const setImportExportOpen = useUiStore((s) => s.setImportExportOpen);
  const dump = useDumpStore((s) => s.dialog);
  const closeDump = useDumpStore((s) => s.close);
  const close = () => setConnectionDialog(null);

  let content = null;
  if (dialog?.mode === "new") content = <ConnectionForm onSaved={close} onCancel={close} />;
  else if (dialog?.mode === "edit") {
    content = <EditConnectionDialog key={dialog.id} id={dialog.id} onClose={close} />;
  } else if (importExportOpen) {
    content = <ConnectionsImportExportDialog onClose={() => setImportExportOpen(false)} />;
  } else if (dump) {
    const Dialog = dump.kind === "backup" ? BackupDialog : RestoreDialog;
    content = <Dialog key={`${dump.kind}/${dump.connection.id}/${dump.database}`} dialog={dump} onClose={closeDump} />;
  }
  return (
    <>
      <Suspense fallback={null}>{content}</Suspense>
      <ObjectDialogs />
      <TransferDialogs />
      <ConfirmDialog />
    </>
  );
}
