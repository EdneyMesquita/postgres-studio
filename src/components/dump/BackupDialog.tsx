import { useEffect, useMemo, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field } from "@/components/connections/Field";
import { api } from "@/lib/tauri";
import { formatBytes } from "@/lib/format";
import { useConnectionsStore } from "@/store/connectionsStore";
import { databaseKey, schemaKey, useExplorerStore } from "@/store/explorerStore";
import type { DumpDialog } from "@/store/dumpStore";
import type { BackupContent, BackupFormat, DumpOptions, DumpSummary, TableRef } from "@/types/pg";
import { Notice, ToolStatus } from "./ToolStatus";
import { ProgressLog } from "./ProgressLog";
import { majorOf, usePgTools, useToolRun } from "./useToolRun";

type Scope = "database" | "schemas" | "tables";

const FORMATS: Record<BackupFormat, { label: string; hint: string; ext: string | null }> = {
  custom: { label: "Custom archive", hint: "Compressed; restore with pg_restore. The usual choice.", ext: "dump" },
  plain: { label: "Plain SQL", hint: "A script any SQL tool can run.", ext: "sql" },
  directory: { label: "Directory", hint: "A folder with a file per table; can dump in parallel.", ext: null },
  tar: { label: "Tar archive", hint: "Uncompressed; restore with pg_restore.", ext: "tar" },
};

const tableKey = (t: TableRef) => `${t.schema}\u0001${t.name}`;

/** `public.orders, audit` -> tables of public (a name without a schema is in public). */
function parseTableList(text: string): TableRef[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const dot = part.indexOf(".");
      return dot < 0 ? { schema: "public", name: part } : { schema: part.slice(0, dot), name: part.slice(dot + 1) };
    });
}

function suggestedName(database: string, format: BackupFormat): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const ext = FORMATS[format].ext;
  return `${database}-${day}${ext ? `.${ext}` : ""}`;
}

/** Backs a database up with pg_dump. */
export function BackupDialog({ dialog, onClose }: { dialog: DumpDialog; onClose: () => void }) {
  const { connection, database } = dialog;
  const session = useConnectionsStore((s) => s.sessions[connection.id]);
  const { tools, error: toolsError } = usePgTools();
  const run = useToolRun<DumpSummary>("dump-progress");

  const node = useExplorerStore((s) => s.databases[databaseKey(connection.id, database)]);
  const schemaNodes = useExplorerStore((s) => s.schemas);
  const [format, setFormat] = useState<BackupFormat>("custom");
  const [content, setContent] = useState<BackupContent>("all");
  const [scope, setScope] = useState<Scope>("database");
  const [pickedSchemas, setPickedSchemas] = useState<Set<string>>(new Set());
  const [pickedTables, setPickedTables] = useState<Set<string>>(new Set());
  const [tableFilter, setTableFilter] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const [noOwner, setNoOwner] = useState(false);
  const [noPrivileges, setNoPrivileges] = useState(false);
  const [clean, setClean] = useState(false);
  const [compression, setCompression] = useState("default");
  const [jobs, setJobs] = useState("1");
  const [dest, setDest] = useState<string | null>(null);

  // The explorer's lists, loaded here when the database was never opened.
  useEffect(() => {
    if (session && !node?.loaded) {
      void useExplorerStore.getState().refreshDatabase(connection.id, session.sessionId, database);
    }
    // once, on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schemas = useMemo(() => (node?.schemas ?? []).filter((s) => !s.system), [node]);
  const tables = useMemo(
    () =>
      schemas.flatMap((s) =>
        (schemaNodes[schemaKey(connection.id, database, s.name)]?.objects?.tables ?? []).map(
          (t): TableRef => ({ schema: s.name, name: t.name }),
        ),
      ),
    [schemas, schemaNodes, connection.id, database],
  );
  const shownTables = tableFilter
    ? tables.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(tableFilter.toLowerCase()))
    : tables;

  const serverMajor = majorOf(session?.serverVersion);
  const dump = tools?.pgDump ?? null;
  const tooOld = dump?.[0] != null && serverMajor != null && dump[0].major < serverMajor;
  const scopeEmpty =
    (scope === "schemas" && pickedSchemas.size === 0) || (scope === "tables" && pickedTables.size === 0);
  const canStart = !!session && !!dump?.[0] && !tooOld && !!dest && !scopeEmpty && !run.running;

  function toggle(set: Set<string>, key: string, on: boolean, update: (next: Set<string>) => void) {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    update(next);
  }

  function changeFormat(next: BackupFormat) {
    setFormat(next);
    // the chosen name carries the old format's extension
    setDest(null);
  }

  async function chooseDest() {
    const ext = FORMATS[format].ext;
    const path = await save({
      defaultPath: dest ?? suggestedName(database, format),
      filters: ext ? [{ name: FORMATS[format].label, extensions: [ext] }] : undefined,
    });
    if (path) setDest(path);
  }

  function start() {
    if (!session || !dest) return;
    const options: DumpOptions = {
      format,
      content,
      schemas: scope === "schemas" ? [...pickedSchemas] : [],
      tables:
        scope === "tables"
          ? tables.filter((t) => pickedTables.has(tableKey(t)))
          : [],
      excludeData: parseTableList(excludeText),
      noOwner,
      noPrivileges,
      clean: format === "plain" && clean,
      compression: compression === "default" || (format !== "custom" && format !== "directory") ? null : Number(compression),
      jobs: format === "directory" ? Math.max(1, Math.min(32, Number(jobs) || 1)) : null,
    };
    void run.run((id) => api.dumpDatabase(session.sessionId, database, options, dest, id));
  }

  const summary = run.result;
  const busy = run.running;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>
            Back up {database} <span className="font-normal text-fg-3">· {connection.name}</span>
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {toolsError ? (
            <Notice tone="danger">
              <span>{toolsError}</span>
            </Notice>
          ) : (
            <ToolStatus name="pg_dump" found={dump} searched={tools?.searched ?? []} needsMajor={serverMajor} />
          )}
          {session?.poolerMode && (
            <Notice tone="warn">
              <span>
                This connection is in pooler mode. pg_dump needs a session-mode connection, so the backup may
                fail.
              </span>
            </Notice>
          )}

          <Field label="Format" htmlFor="backup-format" help={FORMATS[format].hint}>
            <Select value={format} onValueChange={(v) => changeFormat(v as BackupFormat)} disabled={busy}>
              <SelectTrigger id="backup-format" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {(Object.keys(FORMATS) as BackupFormat[]).map((f) => (
                  <SelectItem key={f} value={f}>
                    {FORMATS[f].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="What to back up">
            <SegmentedControl<Scope>
              aria-label="Scope"
              value={scope}
              onChange={setScope}
              options={[
                { value: "database", label: "Whole database" },
                { value: "schemas", label: "Chosen schemas" },
                { value: "tables", label: "Chosen tables" },
              ]}
            />
            {scope === "schemas" && (
              <PickList>
                {schemas.length === 0 && <p className="text-sm text-fg-3">{node?.loading ? "Loading…" : "No schemas"}</p>}
                {schemas.map((s) => (
                  <Label key={s.name} className="font-normal">
                    <Checkbox
                      checked={pickedSchemas.has(s.name)}
                      disabled={busy}
                      onCheckedChange={(on) => toggle(pickedSchemas, s.name, on === true, setPickedSchemas)}
                    />
                    {s.name}
                  </Label>
                ))}
              </PickList>
            )}
            {scope === "tables" && (
              <>
                <Input
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                  placeholder="Filter tables"
                  aria-label="Filter tables"
                />
                <PickList>
                  {tables.length === 0 && <p className="text-sm text-fg-3">No tables loaded yet</p>}
                  {shownTables.map((t) => (
                    <Label key={tableKey(t)} className="font-normal">
                      <Checkbox
                        checked={pickedTables.has(tableKey(t))}
                        disabled={busy}
                        onCheckedChange={(on) => toggle(pickedTables, tableKey(t), on === true, setPickedTables)}
                      />
                      <span className="text-fg-3">{t.schema}.</span>
                      {t.name}
                    </Label>
                  ))}
                </PickList>
              </>
            )}
          </Field>

          <Field label="Content">
            <SegmentedControl<BackupContent>
              aria-label="Content"
              value={content}
              onChange={setContent}
              options={[
                { value: "all", label: "Schema and data" },
                { value: "schema_only", label: "Schema only" },
                { value: "data_only", label: "Data only" },
              ]}
            />
          </Field>

          <div className="flex flex-col gap-2.5">
            <Label className="font-normal">
              <Checkbox checked={noOwner} onCheckedChange={(c) => setNoOwner(c === true)} disabled={busy} />
              Leave out owners (--no-owner)
            </Label>
            <Label className="font-normal">
              <Checkbox
                checked={noPrivileges}
                onCheckedChange={(c) => setNoPrivileges(c === true)}
                disabled={busy}
              />
              Leave out privileges (--no-privileges)
            </Label>
            {format === "plain" && (
              <Label className="font-normal">
                <Checkbox checked={clean} onCheckedChange={(c) => setClean(c === true)} disabled={busy} />
                Drop each object before creating it (--clean --if-exists)
              </Label>
            )}
          </div>

          <Field label="Skip the rows of tables" htmlFor="backup-exclude" help="Comma-separated, e.g. public.audit_log, public.sessions">
            <Input
              id="backup-exclude"
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              placeholder="None"
              disabled={busy}
            />
          </Field>

          {(format === "custom" || format === "directory") && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Compression" htmlFor="backup-compression">
                <Select value={compression} onValueChange={setCompression} disabled={busy}>
                  <SelectTrigger id="backup-compression" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" className="max-h-72">
                    <SelectItem value="default">Default</SelectItem>
                    {Array.from({ length: 10 }, (_, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {i === 0 ? "0 - none" : i}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {format === "directory" && (
                <Field label="Parallel jobs" htmlFor="backup-jobs">
                  <Input
                    id="backup-jobs"
                    type="number"
                    min={1}
                    max={32}
                    value={jobs}
                    onChange={(e) => setJobs(e.target.value)}
                    disabled={busy}
                  />
                </Field>
              )}
            </div>
          )}

          <Field label={format === "directory" ? "Save to folder" : "Save to file"} htmlFor="backup-dest">
            <div className="flex items-center gap-1.5">
              <Input
                id="backup-dest"
                readOnly
                value={dest ?? ""}
                placeholder="Not chosen yet"
                title={dest ?? undefined}
                className="text-fg-3"
              />
              <Button onClick={chooseDest} disabled={busy}>
                Choose…
              </Button>
            </div>
          </Field>

          {busy && <ProgressLog lines={run.lines} objects={run.objects} noun="tables" />}
          {run.cancelled && <p className="text-sm text-fg-2">Cancelled. Nothing was kept.</p>}
          {run.error && (
            <pre role="alert" className="m-0 max-h-40 overflow-auto rounded-md border border-line-soft bg-field p-2 font-mono text-xs whitespace-pre-wrap text-danger">
              {run.error}
            </pre>
          )}
          {summary && (
            <div role="status" className="flex flex-col gap-1.5">
              <p className="flex items-start gap-1.5 text-sm text-ok">
                <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-all">
                  Saved {formatBytes(summary.bytes)} to {summary.path} in {(summary.elapsedMs / 1000).toFixed(1)} s.
                </span>
              </p>
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
          {busy ? (
            <Button onClick={run.cancel}>Cancel backup</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                {summary ? "Close" : "Cancel"}
              </Button>
              <Button variant="primary" disabled={!canStart} onClick={start}>
                {summary || run.error ? "Back up again" : "Back up"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickList({ children }: { children: ReactNode }) {
  return (
    <div className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-md border border-line-soft p-2.5">
      {children}
    </div>
  );
}
