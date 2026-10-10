import { CircleCheck, FileUp, OctagonAlert, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field } from "@/components/connections/Field";
import { formatBytes, formatInt } from "@/lib/format";
import type { CsvTarget } from "@/store/transferStore";
import { formatDuration } from "../scripts/progress";
import { ProgressBar } from "../scripts/ProgressBar";
import { CsvMappingGrid } from "./CsvMappingGrid";
import { useCsvImport } from "./useCsvImport";

interface ImportCsvDialogProps {
  target: CsvTarget;
  onClose: () => void;
}

const DELIMITERS = [
  { value: ",", label: "Comma" },
  { value: ";", label: "Semicolon" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe" },
];

const QUOTES = [
  { value: '"', label: 'Double quote  "' },
  { value: "'", label: "Single quote  '" },
];

/** Loads a CSV file into a table: how to read it, where each column goes, progress. */
export function ImportCsvDialog({ target, onClose }: ImportCsvDialogProps) {
  const csv = useCsvImport(target);
  const running = csv.phase === "running";
  const qualified = `${target.schema}.${target.table}`;

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="sm:max-w-[920px]"
        showCloseButton={!running}
        onEscapeKeyDown={(e) => running && e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Import CSV into {qualified}</DialogTitle>
          <span className="min-w-0 truncate text-sm text-fg-3">
            {target.database} on {target.connection.name}
          </span>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {csv.phase === "setup" && (
            <>
              {csv.readOnly && (
                <p role="alert" className="flex items-center gap-1.5 text-sm text-warn">
                  <TriangleAlert className="size-3.5 shrink-0" />
                  This connection is read-only. Edit the connection to allow changes.
                </p>
              )}
              <section className="flex items-center gap-3">
                <Button onClick={() => void csv.chooseFile()}>
                  <FileUp />
                  {csv.file ? "Choose another file..." : "Choose file..."}
                </Button>
                {csv.file && (
                  <span className="min-w-0 truncate text-base" title={csv.file.path}>
                    {csv.file.name}
                    {csv.preview && <span className="text-fg-3"> {formatBytes(csv.preview.totalBytes)}</span>}
                  </span>
                )}
              </section>

              {csv.file && (
                <section className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line-soft pt-4 sm:grid-cols-4">
                  <Field label="Delimiter" htmlFor="csv-delimiter">
                    <Select value={csv.options.delimiter} onValueChange={(delimiter) => csv.setOptions({ delimiter })}>
                      <SelectTrigger id="csv-delimiter" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DELIMITERS.map((d) => (
                          <SelectItem key={d.value} value={d.value}>
                            {d.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Quote character" htmlFor="csv-quote">
                    <Select value={csv.options.quote} onValueChange={(quote) => csv.setOptions({ quote })}>
                      <SelectTrigger id="csv-quote" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {QUOTES.map((q) => (
                          <SelectItem key={q.value} value={q.value}>
                            {q.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="NULL text" htmlFor="csv-null" help="Empty: an empty field is NULL.">
                    <Input
                      id="csv-null"
                      className="font-data"
                      value={csv.options.nullString}
                      placeholder="Empty field"
                      onChange={(e) => csv.setOptions({ nullString: e.target.value })}
                    />
                  </Field>
                  <Field label="Header">
                    <Label className="h-8 font-normal">
                      <Checkbox checked={csv.options.header} onCheckedChange={(checked) => csv.setOptions({ header: checked === true })} />
                      First row has names
                    </Label>
                  </Field>
                </section>
              )}

              {csv.previewError && (
                <p role="alert" className="flex items-start gap-2 text-base text-danger">
                  <OctagonAlert className="mt-0.5 size-4 shrink-0" />
                  {csv.previewError}
                </p>
              )}
              {csv.columnsError && (
                <p role="alert" className="flex items-start gap-2 text-base text-danger">
                  <OctagonAlert className="mt-0.5 size-4 shrink-0" />
                  Couldn&apos;t read the columns of {qualified}: {csv.columnsError}
                </p>
              )}

              {csv.preview && (
                <section className="flex flex-col gap-2">
                  <p className="text-sm text-fg-3">
                    Pick the column each part of the file goes to; the first {formatInt(csv.preview.rows.length)} rows are shown
                    {csv.preview.more ? ", there are more" : ""}.
                  </p>
                  <CsvMappingGrid
                    preview={csv.preview}
                    columns={csv.columns}
                    mapping={csv.mapping}
                    duplicates={csv.duplicates}
                    onChange={csv.setTarget}
                  />
                  {csv.duplicates.size > 0 && (
                    <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
                      <OctagonAlert className="size-3.5 shrink-0" />
                      More than one column goes to {[...csv.duplicates].join(", ")}.
                    </p>
                  )}
                  {csv.mappedCount === 0 && (
                    <p className="flex items-center gap-1.5 text-sm text-warn">
                      <TriangleAlert className="size-3.5 shrink-0" />
                      Every column is skipped.
                    </p>
                  )}
                  {csv.missing.length > 0 && (
                    <p className="flex items-center gap-1.5 text-sm text-warn">
                      <TriangleAlert className="size-3.5 shrink-0" />
                      No value for {csv.missing.join(", ")}, which can&apos;t be empty and have no default.
                    </p>
                  )}
                </section>
              )}
            </>
          )}

          {running && csv.progress && (
            <section className="flex flex-col gap-3" aria-live="polite">
              <div className="flex items-baseline justify-between gap-3 text-base">
                <span className="min-w-0 truncate">{csv.file?.name}</span>
                <span className="shrink-0 text-fg-3">
                  {formatBytes(csv.progress.bytesRead)} of {formatBytes(csv.progress.totalBytes)}
                </span>
              </div>
              <ProgressBar
                label="Bytes of the file sent"
                value={csv.progress.totalBytes > 0 ? csv.progress.bytesRead / csv.progress.totalBytes : undefined}
              />
              <p className="text-base">
                {formatInt(csv.progress.rows)} rows sent · {formatDuration(csv.elapsedMs)}
              </p>
              <p className="text-sm text-fg-3">The rows become visible together, when the whole file is in.</p>
            </section>
          )}

          {csv.phase === "done" &&
            (csv.summary ? (
              <p role="status" className="flex items-start gap-2 text-base font-medium text-ok">
                <CircleCheck className="mt-0.5 size-4 shrink-0" />
                Imported {formatInt(csv.summary.rows)} rows into {qualified} in {formatDuration(csv.summary.elapsedMs)}.
              </p>
            ) : (
              <div role="alert" className="flex flex-col gap-1.5">
                <p className="flex items-start gap-2 text-base font-medium text-danger">
                  <OctagonAlert className="mt-0.5 size-4 shrink-0" />
                  The import failed and nothing was loaded.
                </p>
                <p className="m-0 text-base whitespace-pre-wrap text-fg-2">{csv.error}</p>
              </div>
            ))}
        </DialogBody>

        <DialogFooter>
          <span className="flex-1" />
          {running ? (
            <Button onClick={csv.cancel}>Cancel import</Button>
          ) : (
            <>
              {csv.phase === "done" && !csv.summary && (
                <Button variant="ghost" onClick={csv.back}>
                  Back to the mapping
                </Button>
              )}
              <Button variant={csv.phase === "done" ? "primary" : "secondary"} onClick={onClose}>
                {csv.phase === "done" ? "Done" : "Cancel"}
              </Button>
              {csv.phase === "setup" && (
                <Button variant="primary" disabled={!csv.readyToImport} onClick={() => void csv.start()}>
                  Import
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
