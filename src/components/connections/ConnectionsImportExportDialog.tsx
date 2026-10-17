import { useId, useState } from "react";
import { CircleCheck, Download, KeyRound, TriangleAlert, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SideNav } from "@/components/ui/side-nav";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FolderNode, TreeNode } from "@/lib/sidebarTree";
import { useSidebarLayoutStore, type ImportTarget } from "../../store/sidebarLayoutStore";
import type { TransferDialog } from "../../store/uiStore";
import {
  CheckboxConnectionTree,
  ConnectionPickerHeader,
  ConnectionTreeEmpty,
  groupState,
  useConnectionTree,
} from "./ConnectionTreePicker";
import { Field } from "./Field";
import { ImportPreviewList } from "./ImportPreviewList";
import { ImportSummary } from "./ImportSummary";
import { SwitchField } from "./SwitchField";
import { useConnectionsTransfer } from "./useConnectionsTransfer";

interface ConnectionsImportExportDialogProps {
  initial: TransferDialog;
  onClose: () => void;
}

/** Every folder, nested ones as "Parent / Child", for the import target. */
function folderPaths(nodes: TreeNode[], prefix = ""): { id: string; path: string }[] {
  return nodes.flatMap((n) => {
    if (n.type !== "folder") return [];
    const folder = n as FolderNode;
    const path = prefix ? `${prefix} / ${folder.name}` : folder.name;
    return [{ id: folder.id, path }, ...folderPaths(folder.children, path)];
  });
}

const targetValue = (t: ImportTarget) => (t.kind === "folder" ? `folder:${t.id}` : t.kind);

/**
 * Export picks which saved connections go in the file, in the sidebar's
 * folders; import previews a file (Postgres Studio's own, or pgAdmin 4's
 * servers.json) and puts what's picked in a folder.
 */
export function ConnectionsImportExportDialog({ initial, onClose }: ConnectionsImportExportDialogProps) {
  const [tab, setTab] = useState(initial.tab);
  const t = useConnectionsTransfer(initial.ids);
  const idPrefix = useId();
  const [query, setQuery] = useState("");
  const { profiles, byId, shown, shownIds, filtered } = useConnectionTree(query);
  const root = useSidebarLayoutStore((s) => s.root);
  const isChecked = (id: string) => t.selected.has(id);
  const exportCount = profiles.filter((p) => t.selected.has(p.id)).length;
  const withPassword = profiles.filter((p) => t.selected.has(p.id) && p.hasPassword).length;
  const importCount = t.pending?.selected.size ?? 0;
  const newFolderName = t.pending?.entries[0]?.format === "pgAdmin" ? "From pgAdmin" : "Imported";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="grid h-[min(640px,calc(100%-2rem))] w-[min(780px,calc(100%-2rem))] max-w-none grid-cols-[156px_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-none"
      >
        <DialogHeader className="col-span-full">
          <DialogTitle>Import and export connections</DialogTitle>
        </DialogHeader>

        <SideNav
          aria-label="Import or export"
          idPrefix={idPrefix}
          value={tab}
          onChange={setTab}
          sections={[
            { id: "export", label: "Export", icon: <Download />, state: String(exportCount) },
            { id: "import", label: "Import", icon: <Upload /> },
          ]}
        />

        <DialogBody
          role="tabpanel"
          id={`${idPrefix}-panel`}
          aria-labelledby={`${idPrefix}-tab-${tab}`}
          className="flex flex-col gap-4 pb-[22px]"
        >
          {tab === "export" ? (
            <>
              <p className="m-0 text-sm leading-normal text-fg-2">
                Pick the connections that go in the file. Postgres Studio reads it back with Import, folders included.
              </p>
              <div className="-mb-2">
                <ConnectionPickerHeader
                  query={query}
                  onQueryChange={setQuery}
                  selectAll={{
                    state: shownIds.length === 0 ? false : groupState(shownIds, isChecked),
                    disabled: shownIds.length === 0,
                    onToggle: () => t.setExportChecked(shownIds, groupState(shownIds, isChecked) !== true),
                    filtered,
                  }}
                  count={`${exportCount} of ${profiles.length} selected`}
                />
              </div>
              <div className="rounded-md border border-line p-1">
                {shown.length === 0 ? (
                  <ConnectionTreeEmpty hasProfiles={profiles.length > 0} query={query} />
                ) : (
                  <CheckboxConnectionTree
                    nodes={shown}
                    byId={byId}
                    isChecked={isChecked}
                    setChecked={t.setExportChecked}
                    connectionTrailing={(p) => (
                      <span className="inline-flex items-center gap-1 text-xs text-fg-3">
                        {p.hasPassword ? (
                          <>
                            <KeyRound className="size-3" />
                            password saved
                          </>
                        ) : (
                          "no password"
                        )}
                      </span>
                    )}
                    aria-label="Connections to export"
                  />
                )}
              </div>
              <SwitchField
                label="Include passwords (plaintext)"
                description={`${withPassword} of the selected connections ${withPassword === 1 ? "has" : "have"} a saved password. Without this they export without it.`}
                checked={t.includeSecrets}
                onCheckedChange={t.setIncludeSecrets}
                disabled={t.busy}
              />
              {t.includeSecrets && (
                <p className="-mt-1.5 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/9 px-2.5 py-2 text-sm leading-[1.45] text-fg-2">
                  <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" />
                  <span>
                    <b className="font-medium text-fg">The file will hold plaintext credentials.</b> Store it somewhere
                    safe, and delete it once imported.
                  </span>
                </p>
              )}
            </>
          ) : (
            <>
              <p className="m-0 text-sm leading-normal text-fg-2">
                A Postgres Studio export, or pgAdmin 4&apos;s servers.json (File › Export servers in pgAdmin). pgAdmin
                doesn&apos;t export passwords: you add them when you first connect.
              </p>
              <Button className="self-start" onClick={t.chooseImportFile} disabled={t.busy}>
                <Upload />
                {t.pending ? "Choose another file…" : "Choose file…"}
              </Button>
              {t.pending && (
                <>
                  <ImportPreviewList
                    pending={t.pending}
                    importableCount={t.importableCount}
                    allSelected={t.allSelected}
                    onToggle={t.toggle}
                    onToggleAll={t.toggleAll}
                  />
                  <Field label="Put them in">
                    <Select
                      value={targetValue(t.target)}
                      onValueChange={(v) =>
                        t.setTarget(
                          v === "new" ? { kind: "new", name: newFolderName }
                          : v === "root" ? { kind: "root" }
                          : { kind: "folder", id: v.slice("folder:".length) },
                        )
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new">New folder “{newFolderName}”</SelectItem>
                        {folderPaths(root).map((f) => (
                          <SelectItem key={f.id} value={`folder:${f.id}`}>
                            {f.path}
                          </SelectItem>
                        ))}
                        <SelectItem value="root">No folder</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  {t.pending.entries.some((e) => e.folder) && (
                    <p className="-mt-2.5 mb-0 text-xs text-fg-3">Folders the file has inside it stay as subfolders.</p>
                  )}
                </>
              )}
              {t.importResult && <ImportSummary result={t.importResult} />}
            </>
          )}
        </DialogBody>

        <DialogFooter className="col-span-full">
          <span
            role={t.error ? "alert" : "status"}
            className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm"
            title={t.error ?? undefined}
          >
            {t.error ? (
              <span className="truncate text-danger">{t.error}</span>
            ) : tab === "export" && t.exportedCount !== null ? (
              <span className="flex items-center gap-1.5 text-ok">
                <CircleCheck className="size-3.5" />
                Exported {t.exportedCount.toLocaleString()} connection{t.exportedCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {tab === "export" ? (
            <Button variant="primary" disabled={t.busy || exportCount === 0} onClick={t.exportToFile}>
              <Download />
              Export {exportCount} connection{exportCount === 1 ? "" : "s"}…
            </Button>
          ) : (
            t.pending && (
              <Button variant="primary" disabled={t.busy || importCount === 0} onClick={t.importSelected}>
                Import {importCount} connection{importCount === 1 ? "" : "s"}
              </Button>
            )
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
