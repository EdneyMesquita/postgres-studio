import { CircleCheck, FileUp, OctagonAlert, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { formatBytes, formatInt } from "@/lib/format";
import type { ScriptTarget } from "@/store/transferStore";
import type { ScriptSummary } from "@/types/pg";
import { formatDuration } from "./progress";
import { ProgressBar } from "./ProgressBar";
import { useScriptRun } from "./useScriptRun";

interface RunSqlFileDialogProps {
  target: ScriptTarget;
  onClose: () => void;
}

/** Runs a SQL file on a database: options, progress, then what went wrong. */
export function RunSqlFileDialog({ target, onClose }: RunSqlFileDialogProps) {
  const run = useScriptRun(target);
  const running = run.phase === "running";

  return (
    <Dialog open onOpenChange={(open) => !open && !running && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="sm:max-w-[640px]"
        showCloseButton={!running}
        onEscapeKeyDown={(e) => running && e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Run SQL file</DialogTitle>
          <span className="min-w-0 truncate text-sm text-fg-3">
            {target.database} on {target.connection.name}
          </span>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {run.phase === "setup" && (
            <>
              <section className="flex items-center gap-3">
                <Button onClick={() => void run.chooseFile()}>
                  <FileUp />
                  {run.file ? "Choose another file..." : "Choose file..."}
                </Button>
                {run.file && (
                  <span className="min-w-0 truncate text-base" title={run.file.path}>
                    {run.file.name} <span className="text-fg-3">{formatBytes(run.file.sizeBytes)}</span>
                  </span>
                )}
              </section>

              <section className="flex flex-col gap-3 border-t border-line-soft pt-4">
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-fg">When a statement fails</span>
                  <SegmentedControl
                    aria-label="When a statement fails"
                    className="self-start"
                    value={run.options.stopOnError ? "stop" : "continue"}
                    onChange={(v) => run.setOptions((o) => ({ ...o, stopOnError: v === "stop" }))}
                    options={[
                      { value: "stop", label: "Stop" },
                      { value: "continue", label: "Continue", title: "Run the rest and list the failures" },
                    ]}
                  />
                </div>
                <Label className="font-normal">
                  <Checkbox
                    checked={run.options.singleTransaction}
                    onCheckedChange={(checked) => run.setSingleTransaction(checked === true)}
                  />
                  Run in a single transaction
                </Label>
                <p className="text-sm text-fg-3">
                  {run.options.singleTransaction
                    ? "Nothing is kept unless every statement succeeds, so it stops at the first error."
                    : "Each statement is applied as it runs; an error leaves what ran before it in place."}
                </p>
              </section>

              <p className="text-sm text-fg-3">
                The file is read from disk as it runs, so large dumps are fine. COPY ... FROM stdin blocks load their
                data; psql commands such as \connect are skipped.
              </p>
            </>
          )}

          {running && run.progress && (
            <section className="flex flex-col gap-3" aria-live="polite">
              <div className="flex items-baseline justify-between gap-3 text-base">
                <span className="min-w-0 truncate">{run.file?.name}</span>
                <span className="shrink-0 text-fg-3">
                  {formatBytes(run.progress.bytesRead)} of {formatBytes(run.progress.totalBytes)}
                </span>
              </div>
              <ProgressBar
                label="Bytes of the file read"
                value={run.progress.totalBytes > 0 ? run.progress.bytesRead / run.progress.totalBytes : undefined}
              />
              <dl className="m-0 grid grid-cols-3 gap-3 text-base">
                <Stat label="Statements" value={formatInt(run.progress.statementsDone)} />
                <Stat label="Errors" value={formatInt(run.progress.errors)} danger={run.progress.errors > 0} />
                <Stat label="Elapsed" value={formatDuration(run.elapsedMs)} />
              </dl>
              <code className="block truncate rounded-md bg-field px-2.5 py-1.5 font-data text-sm text-fg-2" title={run.progress.currentPreview}>
                {run.progress.currentPreview || "Starting..."}
              </code>
            </section>
          )}

          {run.phase === "done" && (run.summary ? <Summary summary={run.summary} /> : <ErrorNote message={run.error} />)}
        </DialogBody>

        <DialogFooter>
          {run.phase === "setup" && (
            <span role={run.error ? "alert" : undefined} className="min-w-0 flex-1 truncate text-sm text-danger" title={run.error ?? undefined}>
              {run.error}
            </span>
          )}
          {run.phase !== "setup" && <span className="flex-1" />}
          {running ? (
            <Button onClick={run.cancel}>Cancel run</Button>
          ) : (
            <>
              {run.phase === "done" && (
                <Button variant="ghost" onClick={run.reset}>
                  Run another file
                </Button>
              )}
              <Button variant={run.phase === "done" ? "primary" : "secondary"} onClick={onClose}>
                {run.phase === "done" ? "Done" : "Cancel"}
              </Button>
              {run.phase === "setup" && (
                <Button variant="primary" disabled={!run.file} onClick={() => void run.start()}>
                  Run file
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-fg-3">{label}</dt>
      <dd className={danger ? "m-0 font-medium text-danger" : "m-0 font-medium"}>{value}</dd>
    </div>
  );
}

function ErrorNote({ message }: { message: string | null }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-base text-danger">
      <OctagonAlert className="mt-0.5 size-4 shrink-0" />
      {message ?? "The run ended without a result."}
    </p>
  );
}

/** How the run ended, in a sentence. */
function outcome(s: ScriptSummary): { text: string; tone: "ok" | "warn" | "danger" } {
  const statements = `${formatInt(s.statements)} statement${s.statements === 1 ? "" : "s"}`;
  const errors = `${formatInt(s.errorCount)} error${s.errorCount === 1 ? "" : "s"}`;
  if (s.cancelled) {
    return { text: `Cancelled after ${statements}.${s.rolledBack ? " Everything was rolled back." : ""}`, tone: "warn" };
  }
  if (s.stopped) {
    return { text: `Stopped at the first error, after ${statements}.${s.rolledBack ? " Everything was rolled back." : ""}`, tone: "danger" };
  }
  if (s.errorCount > 0) return { text: `Ran ${statements} with ${errors}.`, tone: "danger" };
  return { text: `Ran ${statements} without errors.`, tone: "ok" };
}

function Summary({ summary }: { summary: ScriptSummary }) {
  const { text, tone } = outcome(summary);
  const Icon = tone === "ok" ? CircleCheck : tone === "warn" ? TriangleAlert : OctagonAlert;
  const toneClass = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-danger";
  const hidden = summary.errorCount - summary.errors.length;
  return (
    <section className="flex flex-col gap-3" aria-live="polite">
      <p role="status" className={`flex items-start gap-2 text-base font-medium ${toneClass}`}>
        <Icon className="mt-0.5 size-4 shrink-0" />
        {text}
      </p>
      <p className="text-sm text-fg-3">
        {formatDuration(summary.elapsedMs)}
        {summary.copiedRows > 0 && ` · ${formatInt(summary.copiedRows)} rows loaded with COPY`}
      </p>

      {summary.errors.length > 0 && (
        <ul className="m-0 flex max-h-64 list-none flex-col divide-y divide-line-soft overflow-y-auto rounded-md border border-line p-0">
          {summary.errors.map((e) => (
            <li key={e.index} className="flex flex-col gap-0.5 px-3 py-2">
              <span className="text-sm text-fg-3">
                Line {formatInt(e.line)} · statement {formatInt(e.index)}
                {e.code && <span className="font-data"> · {e.code}</span>}
              </span>
              <span className="text-base whitespace-pre-wrap">{e.message}</span>
            </li>
          ))}
          {hidden > 0 && <li className="px-3 py-2 text-sm text-fg-3">and {formatInt(hidden)} more</li>}
        </ul>
      )}

      {summary.warningCount > 0 && (
        <details className="text-sm text-fg-2">
          <summary className="cursor-pointer">
            {formatInt(summary.warningCount)} psql command{summary.warningCount === 1 ? "" : "s"} skipped
          </summary>
          <ul className="m-0 mt-1.5 list-none p-0">
            {summary.warnings.map((w) => (
              <li key={`${w.line}-${w.message}`}>
                Line {formatInt(w.line)}: {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
