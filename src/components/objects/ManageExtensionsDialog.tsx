import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { extensionState, filterExtensions } from "@/lib/extensions";
import type { ExtensionFilter } from "@/lib/extensions";
import { objectsApi } from "../../lib/objectsApi";
import { confirm } from "../../store/confirmStore";
import { useConnectionsStore } from "../../store/connectionsStore";
import { databaseKey, useExplorerStore } from "../../store/explorerStore";
import { refreshAfterExtensionChange } from "../../store/extensionsStore";
import type { DatabaseTarget } from "../../store/objectDialogsStore";
import type { AvailableExtension, ExtensionAction } from "../../types/objects";

const STATE_LABEL = { available: "not installed", installed: "installed", update: "update available" } as const;
const STATE_CLASS = { available: "text-fg-3", installed: "text-ok", update: "text-warn" } as const;

/** Installs, updates and drops the extensions of one database, after a confirmation each. */
export function ManageExtensionsDialog({ target, onClose }: { target: DatabaseTarget; onClose: () => void }) {
  const { connection, sessionId, database } = target;
  const readOnly = useConnectionsStore((s) => s.sessions[connection.id]?.readOnly ?? false);
  const schemas = useExplorerStore((s) => s.databases[databaseKey(connection.id, database)]?.schemas ?? []);
  const [list, setList] = useState<AvailableExtension[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ExtensionFilter>("all");
  const [schema, setSchema] = useState("");
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await objectsApi.listAvailableExtensions(sessionId, database));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, database]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => filterExtensions(list ?? [], query, filter), [list, query, filter]);

  async function run(e: AvailableExtension, action: ExtensionAction) {
    const into = action.kind === "install" && action.schema ? ` into schema ${action.schema}` : "";
    const asked =
      action.kind === "install"
        ? {
            title: `Install ${e.name}?`,
            message: `Runs CREATE EXTENSION IF NOT EXISTS ${e.name}${into} in ${database}${e.defaultVersion ? `, at version ${e.defaultVersion}` : ""}.`,
            confirmLabel: "Install",
          }
        : action.kind === "update"
          ? {
              title: `Update ${e.name}?`,
              message: `Runs ALTER EXTENSION ${e.name} UPDATE in ${database}, from ${e.installedVersion} to ${e.defaultVersion}.`,
              confirmLabel: "Update",
            }
          : {
              title: `Drop ${e.name}?`,
              message: action.cascade
                ? `Runs DROP EXTENSION ${e.name} CASCADE in ${database}. CASCADE also drops every object that depends on the extension: columns of its types, indexes using its operator classes, views, functions. This cannot be undone.`
                : `Runs DROP EXTENSION ${e.name} in ${database}. It fails if anything depends on it; tick CASCADE to drop those too.`,
              confirmLabel: action.cascade ? "Drop with CASCADE" : "Drop",
              danger: true,
            };
    if (!(await confirm(asked))) return;
    setBusy(e.name);
    try {
      await objectsApi.extensionAction(sessionId, database, e.name, action);
      toast.success(`${action.kind === "install" ? "Installed" : action.kind === "update" ? "Updated" : "Dropped"} ${e.name}`);
      await Promise.all([load(), refreshAfterExtensionChange(connection.id, sessionId, database)]);
    } catch (err) {
      toast.error(`Couldn't ${action.kind} ${e.name}`, { description: String(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title={`Extensions of ${database}`}
      onClose={onClose}
      width="max-w-3xl"
      bodyClassName="p-0"
      subheader={
        <div className="flex flex-col gap-2 px-4 py-2.5">
          {readOnly && (
            <p className="m-0 rounded-md bg-warn/10 px-2.5 py-1.5 text-sm text-warn">
              {connection.name} is read-only, so extensions can't be installed, updated or dropped here. Edit the connection to allow changes.
            </p>
          )}
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-fg-3" aria-hidden />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or description"
                aria-label="Search extensions"
                className="pl-8"
              />
            </div>
            <SegmentedControl
              aria-label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "installed", label: "Installed" },
                { value: "update", label: "Updates" },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-fg-2">
            <label className="flex items-center gap-2">
              Install into schema
              <Input
                list="extension-schemas"
                value={schema}
                onChange={(e) => setSchema(e.target.value)}
                placeholder="default"
                aria-label="Schema for new installs"
                spellCheck={false}
                className="h-7 w-40 font-data"
              />
              <datalist id="extension-schemas">
                {schemas.filter((s) => !s.system).map((s) => (
                  <option key={s.name} value={s.name} />
                ))}
              </datalist>
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={cascade} onCheckedChange={(v) => setCascade(v === true)} />
              <span>
                Drop with <span className="font-medium text-danger">CASCADE</span>
                <span className="text-fg-3"> (also drops what depends on the extension)</span>
              </span>
            </label>
          </div>
        </div>
      }
      footer={
        <>
          <span className="flex-1 text-sm text-fg-3">{list ? `${shown.length} of ${list.length} extensions` : ""}</span>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {error ? (
        <p className="m-0 p-4 text-sm text-danger">{error}</p>
      ) : !list ? (
        <p className="m-0 p-4 text-sm text-fg-3">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="m-0 p-4 text-sm text-fg-3">No extension matches.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {shown.map((e) => {
            const state = extensionState(e);
            const working = busy === e.name;
            return (
              <li key={e.name} className="flex items-center gap-3 border-b border-line-soft px-4 py-2 hover:bg-row-hover">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-data font-medium">{e.name}</span>
                    <span className={cn("text-xs", STATE_CLASS[state])}>{STATE_LABEL[state]}</span>
                  </div>
                  {e.comment && <div className="truncate text-sm text-fg-3" title={e.comment}>{e.comment}</div>}
                </div>
                <div className="w-36 shrink-0 text-right text-sm tabular-nums text-fg-2" title="Installed version, and the version the server offers">
                  {e.installedVersion ? `${e.installedVersion}${state === "update" ? ` → ${e.defaultVersion}` : ""}` : (e.defaultVersion ?? "")}
                  {e.schema && <div className="text-xs text-fg-3">in {e.schema}</div>}
                </div>
                <div className="flex w-28 shrink-0 justify-end gap-1">
                  {state === "available" && (
                    <Button size="sm" disabled={readOnly || busy !== null} onClick={() => void run(e, { kind: "install", schema: schema.trim() || null })}>
                      <Download />
                      {working ? "Installing…" : "Install"}
                    </Button>
                  )}
                  {state === "update" && (
                    <Button size="sm" disabled={readOnly || busy !== null} onClick={() => void run(e, { kind: "update" })}>
                      <RefreshCw />
                      {working ? "Updating…" : "Update"}
                    </Button>
                  )}
                  {state !== "available" && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={cascade ? `Drop ${e.name} with CASCADE` : `Drop ${e.name}`}
                      aria-label={`Drop ${e.name}`}
                      className="hover:text-danger"
                      disabled={readOnly || busy !== null}
                      onClick={() => void run(e, { kind: "drop", cascade })}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
