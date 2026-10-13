import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CircleCheck } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Field } from "@/components/connections/Field";
import { api } from "@/lib/tauri";
import { useConnectionsStore } from "@/store/connectionsStore";
import { confirm } from "@/store/confirmStore";
import { useExplorerStore } from "@/store/explorerStore";
import type { DumpDialog } from "@/store/dumpStore";
import type { BackupContent, BackupFormat, RestoreOptions, RestoreSummary } from "@/types/pg";
import { Notice, ToolStatus } from "./ToolStatus";
import { ProgressLog } from "./ProgressLog";
import { usePgTools, useToolRun } from "./useToolRun";

const FORMAT_NAMES: Record<BackupFormat, string> = {
  custom: "Custom archive",
  plain: "Plain SQL",
  directory: "Directory backup",
  tar: "Tar archive",
};

/** Whether the database holds anything a restore could clash with or drop. */
async function hasObjects(sessionId: string, database: string): Promise<boolean> {
  const schemas = (await api.listSchemas(sessionId, database)).filter((s) => !s.system);
  if (schemas.some((s) => s.name !== "public")) return true;
  if (!schemas.some((s) => s.name === "public")) return false;
  const o = await api.listSchemaObjects(sessionId, database, "public");
  return [o.tables, o.views, o.materializedViews, o.continuousAggregates ?? [], o.sequences, o.functions, o.types].some((l) => l.length > 0);
}

/** Restores a backup into a database with pg_restore, or psql for a SQL file. */
export function RestoreDialog({ dialog, onClose }: { dialog: DumpDialog; onClose: () => void }) {
  const { connection, database } = dialog;
  const session = useConnectionsStore((s) => s.sessions[connection.id]);
  const { tools, error: toolsError } = usePgTools();
  const run = useToolRun<RestoreSummary>("restore-progress");

  const [source, setSource] = useState<string | null>(null);
  const [format, setFormat] = useState<BackupFormat | null>(null);
  const [formatError, setFormatError] = useState<string | null>(null);
  const [content, setContent] = useState<BackupContent>("all");
  const [clean, setClean] = useState(false);
  const [create, setCreate] = useState(false);
  const [noOwner, setNoOwner] = useState(false);
  const [noPrivileges, setNoPrivileges] = useState(false);
  const [single, setSingle] = useState(false);
  const [exitOnError, setExitOnError] = useState(false);
  const [jobs, setJobs] = useState("1");
  const [checking, setChecking] = useState(false);

  const readOnly = session?.readOnly ?? false;
  const plain = format === "plain";
  const archive = format !== null && !plain;
  const needed = plain ? tools?.psql : tools?.pgRestore;
  const neededName = plain ? "psql" : "pg_restore";
  const busy = run.running || checking;
  const canStart = !!session && !readOnly && !!source && !!format && !!needed?.[0] && !busy;

  async function pick(directory: boolean) {
    const picked = await open({ multiple: false, directory });
    if (typeof picked !== "string") return;
    setSource(picked);
    setFormat(null);
    setFormatError(null);
    try {
      setFormat(await api.backupFormat(picked));
    } catch (e) {
      setFormatError(String(e));
    }
  }

  async function start() {
    if (!session || !source || !format) return;
    setChecking(true);
    let proceed = true;
    try {
      const dropping = archive && clean;
      const nonEmpty = await hasObjects(session.sessionId, database).catch(() => true);
      if (dropping || nonEmpty) {
        proceed = await confirm({
          title: dropping ? "Drop objects and restore?" : "Restore into a database that has data?",
          message: dropping
            ? `Restoring with "drop objects first" deletes the objects of ${database} that the backup also holds, with their data, before recreating them. This can't be undone.`
            : `${database} already has objects. Restoring into it can fail on the ones that exist, and a SQL file may add its rows to the ones already there.`,
          confirmLabel: "Restore",
          danger: true,
        });
      }
    } finally {
      setChecking(false);
    }
    if (!proceed) return;
    // A SQL file takes none of the archive options, whatever was ticked before.
    const options: RestoreOptions = archive
      ? {
          content,
          clean,
          create,
          noOwner,
          noPrivileges,
          singleTransaction: single,
          exitOnError,
          jobs: !single && format !== "tar" ? Math.max(1, Math.min(32, Number(jobs) || 1)) : null,
        }
      : {
          content: "all",
          clean: false,
          create: false,
          noOwner: false,
          noPrivileges: false,
          singleTransaction: single,
          exitOnError: false,
          jobs: null,
        };
    await run.run(async (id) => {
      try {
        return await api.restoreDatabase(session.sessionId, database, source, options, id);
      } finally {
        // what the restore created shows up in the tree
        void useExplorerStore.getState().refreshDatabase(connection.id, session.sessionId, database);
        void useConnectionsStore.getState().refreshDatabases(connection.id);
      }
    });
  }

  const summary = run.result;
  const dis = busy || !archive;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            Restore into {database} <span className="font-normal text-fg-3">· {connection.name}</span>
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {readOnly && (
            <Notice tone="warn">
              <span>This connection is read-only, so it can't restore a backup. Edit the connection to turn that off.</span>
            </Notice>
          )}
          {toolsError ? (
            <Notice tone="danger">
              <span>{toolsError}</span>
            </Notice>
          ) : (
            format && (
              <ToolStatus name={neededName} found={needed ?? null} searched={tools?.searched ?? []} />
            )
          )}

          <Field label="Backup" htmlFor="restore-source">
            <div className="flex items-center gap-1.5">
              <Input
                id="restore-source"
                readOnly
                value={source ?? ""}
                placeholder="Not chosen yet"
                title={source ?? undefined}
                className="text-fg-3"
              />
              <Button onClick={() => void pick(false)} disabled={busy || readOnly}>
                File…
              </Button>
              <Button onClick={() => void pick(true)} disabled={busy || readOnly}>
                Folder…
              </Button>
            </div>
            {format && <p className="text-sm text-fg-2">Detected: {FORMAT_NAMES[format]}</p>}
            {formatError && (
              <p role="alert" className="text-sm text-danger">
                {formatError}
              </p>
            )}
          </Field>

          {plain && (
            <p className="text-sm text-fg-2">
              A SQL file runs as it is, and stops at the first error. Only the single-transaction option applies.
            </p>
          )}

          <Field label="What to restore">
            <SegmentedControl<BackupContent>
              aria-label="What to restore"
              value={content}
              onChange={(c) => {
                setContent(c);
                if (c === "data_only") setClean(false);
              }}
              options={[
                { value: "all", label: "Schema and data" },
                { value: "schema_only", label: "Schema only" },
                { value: "data_only", label: "Data only" },
              ]}
              className={dis ? "pointer-events-none opacity-50" : undefined}
            />
          </Field>

          <div className="flex flex-col gap-2.5">
            <Label className="font-normal">
              <Checkbox
                checked={clean}
                onCheckedChange={(c) => setClean(c === true)}
                disabled={dis || content === "data_only"}
              />
              Drop objects first (--clean --if-exists)
            </Label>
            <Label className="font-normal">
              <Checkbox
                checked={create}
                onCheckedChange={(c) => setCreate(c === true)}
                disabled={dis || single}
              />
              Create the database from the backup (connects to {database} first)
            </Label>
            <Label className="font-normal">
              <Checkbox checked={noOwner} onCheckedChange={(c) => setNoOwner(c === true)} disabled={dis} />
              Leave out owners (--no-owner)
            </Label>
            <Label className="font-normal">
              <Checkbox
                checked={noPrivileges}
                onCheckedChange={(c) => setNoPrivileges(c === true)}
                disabled={dis}
              />
              Leave out privileges (--no-privileges)
            </Label>
            <Label className="font-normal">
              <Checkbox
                checked={single}
                onCheckedChange={(c) => {
                  setSingle(c === true);
                  if (c === true) setCreate(false);
                }}
                disabled={busy || format === null}
              />
              All in one transaction: nothing is kept if anything fails
            </Label>
            <Label className="font-normal">
              <Checkbox
                checked={exitOnError || single}
                onCheckedChange={(c) => setExitOnError(c === true)}
                disabled={dis || single}
              />
              Stop at the first error (--exit-on-error)
            </Label>
          </div>

          {archive && format !== "tar" && (
            <Field label="Parallel jobs" htmlFor="restore-jobs" help={single ? "Not available in a single transaction" : undefined}>
              <Input
                id="restore-jobs"
                type="number"
                min={1}
                max={32}
                value={jobs}
                onChange={(e) => setJobs(e.target.value)}
                disabled={busy || single}
                className="w-24"
              />
            </Field>
          )}

          {run.running && <ProgressLog lines={run.lines} objects={run.objects} />}
          {run.cancelled && <p className="text-sm text-fg-2">Cancelled. What was already restored stays in {database}.</p>}
          {run.error && (
            <pre role="alert" className="m-0 max-h-40 overflow-auto rounded-md border border-line-soft bg-field p-2 font-mono text-xs whitespace-pre-wrap text-danger">
              {run.error}
            </pre>
          )}
          {summary && (
            <div role="status" className="flex flex-col gap-1.5">
              <p className={`flex items-start gap-1.5 text-sm ${summary.errors.length ? "text-warn" : "text-ok"}`}>
                <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {summary.errors.length
                  ? `Restored in ${(summary.elapsedMs / 1000).toFixed(1)} s, with ${summary.errors.length} error${summary.errors.length === 1 ? "" : "s"}.`
                  : `Restored in ${(summary.elapsedMs / 1000).toFixed(1)} s.`}
              </p>
              {summary.errors.length > 0 && (
                <ul className="m-0 flex max-h-40 list-none flex-col gap-1 overflow-auto rounded-md border border-line-soft bg-field p-2 font-mono text-xs text-danger">
                  {summary.errors.slice(0, 20).map((e, i) => (
                    <li key={i} className="break-words">
                      {e}
                    </li>
                  ))}
                  {summary.errors.length > 20 && (
                    <li className="text-fg-3">and {summary.errors.length - 20} more</li>
                  )}
                </ul>
              )}
              {summary.warnings.map((w, i) => (
                <Notice key={i} tone="warn">
                  <span className="break-words">{w}</span>
                </Notice>
              ))}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <span className="flex-1" />
          {run.running ? (
            <Button onClick={run.cancel}>Cancel restore</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={checking}>
                {summary ? "Close" : "Cancel"}
              </Button>
              <Button variant="primary" disabled={!canStart} onClick={() => void start()}>
                Restore
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
