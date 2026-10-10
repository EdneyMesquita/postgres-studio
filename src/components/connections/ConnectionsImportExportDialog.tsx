import { CircleCheck, Download, TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ImportPreviewList } from "./ImportPreviewList";
import { ImportSummary } from "./ImportSummary";
import { SectionTitle } from "./SectionTitle";
import { useConnectionsTransfer } from "./useConnectionsTransfer";

interface ConnectionsImportExportDialogProps {
  onClose: () => void;
}

export function ConnectionsImportExportDialog({ onClose }: ConnectionsImportExportDialogProps) {
  const t = useConnectionsTransfer();
  const selectedCount = t.pending?.selected.size ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Import and export connections</DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <p className="text-sm text-fg-2">
            Exports Postgres Studio's own JSON. Import reads that, and pgAdmin 4&apos;s servers.json
            (File &gt; Export servers in pgAdmin).
          </p>

          <section className="flex flex-col gap-3">
            <SectionTitle>Export</SectionTitle>
            <Label className="font-normal">
              <Checkbox
                checked={t.includeSecrets}
                onCheckedChange={(checked) => t.setIncludeSecrets(checked === true)}
                disabled={t.busy}
              />
              Include passwords (plaintext) in the exported file
            </Label>
            {t.includeSecrets && (
              <p className="flex items-center gap-1.5 text-sm text-warn">
                <TriangleAlert className="size-3.5 shrink-0" />
                The file will contain plaintext credentials - store it somewhere safe.
              </p>
            )}
            <div className="flex items-center gap-3">
              <Button onClick={t.exportToFile} disabled={t.busy}>
                <Download />
                Export to file...
              </Button>
              {t.exportedCount !== null && (
                <span role="status" className="flex items-center gap-1.5 text-sm text-ok">
                  <CircleCheck className="size-3.5" />
                  Exported {t.exportedCount.toLocaleString()} connection
                  {t.exportedCount === 1 ? "" : "s"}.
                </span>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-3 border-t border-line-soft pt-4">
            <SectionTitle>Import</SectionTitle>
            <p className="text-sm text-fg-2">
              Import a Postgres Studio export, or pgAdmin 4&apos;s servers.json. pgAdmin
              doesn&apos;t export passwords: add them by editing each connection.
            </p>
            <Button className="self-start" onClick={t.chooseImportFile} disabled={t.busy}>
              <Upload />
              {t.pending ? "Choose another file..." : "Choose file..."}
            </Button>
            {t.pending && (
              <ImportPreviewList
                pending={t.pending}
                importableCount={t.importableCount}
                allSelected={t.allSelected}
                onToggle={t.toggle}
                onToggleAll={t.toggleAll}
              />
            )}
            {t.importResult && <ImportSummary result={t.importResult} />}
          </section>
        </DialogBody>

        <DialogFooter>
          <span
            role={t.error ? "alert" : undefined}
            className="min-w-0 flex-1 truncate text-sm text-danger"
            title={t.error ?? undefined}
          >
            {t.error}
          </span>
          <Button variant={t.pending ? "ghost" : "secondary"} onClick={onClose}>
            Close
          </Button>
          {t.pending && (
            <Button variant="primary" disabled={t.busy || selectedCount === 0} onClick={t.importSelected}>
              Import {selectedCount} connection{selectedCount === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
