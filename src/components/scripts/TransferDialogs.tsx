import { lazy, Suspense } from "react";
import { useTransferStore } from "@/store/transferStore";

// Loaded on first use, keeping them out of the startup bundle.
const RunSqlFileDialog = lazy(() => import("./RunSqlFileDialog").then((m) => ({ default: m.RunSqlFileDialog })));
const ImportCsvDialog = lazy(() => import("../import/ImportCsvDialog").then((m) => ({ default: m.ImportCsvDialog })));

/** The "Run SQL file" and "Import CSV" dialogs, opened from the tree, the palette and table tabs. */
export function TransferDialogs() {
  const script = useTransferStore((s) => s.scriptTarget);
  const csv = useTransferStore((s) => s.csvTarget);
  const setScript = useTransferStore((s) => s.setScriptTarget);
  const setCsv = useTransferStore((s) => s.setCsvTarget);
  return (
    <Suspense fallback={null}>
      {script && <RunSqlFileDialog target={script} onClose={() => setScript(null)} />}
      {csv && <ImportCsvDialog target={csv} onClose={() => setCsv(null)} />}
    </Suspense>
  );
}
