import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri";
import { useConnectionsStore } from "@/store/connectionsStore";
import { useSidebarLayoutStore, type ImportTarget } from "@/store/sidebarLayoutStore";
import type { ConnectionImportPreview, ConnectionsImportSummary } from "@/types/connection";

/** A file picked for import, with what it holds and what's ticked. */
export interface PendingImport {
  path: string;
  entries: ConnectionImportPreview[];
  selected: Set<number>;
}

const JSON_FILES = [{ name: "JSON", extensions: ["json"] }];

/**
 * Export and import of connection files: the export takes the connections
 * picked in `selected`, the import has its pick-before-import step and a
 * folder to put them in.
 */
export function useConnectionsTransfer(initialIds: string[] | null) {
  const refreshProfiles = useConnectionsStore((s) => s.refreshProfiles);
  const profiles = useConnectionsStore((s) => s.profiles);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialIds ?? profiles.map((p) => p.id)));
  const [target, setTarget] = useState<ImportTarget>({ kind: "new", name: "Imported" });
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportedCount, setExportedCount] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [importResult, setImportResult] = useState<ConnectionsImportSummary | null>(null);

  async function exportToFile() {
    const destPath = await save({ defaultPath: "connections.json", filters: JSON_FILES });
    if (!destPath) return;

    setBusy(true);
    setError(null);
    setExportedCount(null);
    try {
      // In sidebar order, the order the picker shows them.
      const ids = profiles.map((p) => p.id).filter((id) => selected.has(id));
      const summary = await api.exportConnections(destPath, includeSecrets, ids);
      setExportedCount(summary.exported);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseImportFile() {
    const srcPath = await open({ multiple: false, filters: JSON_FILES });
    if (!srcPath || Array.isArray(srcPath)) return;

    setBusy(true);
    setError(null);
    setImportResult(null);
    try {
      const entries = await api.previewConnectionsImport(srcPath);
      // Everything importable is ticked, except names you already have:
      // re-importing an export would otherwise duplicate them all.
      const selected = new Set(
        entries.filter((e) => e.error === null && !e.exists).map((e) => e.index),
      );
      setPending({ path: srcPath, entries, selected });
      // A new folder named after where they came from, unless the user picked another place.
      setTarget((t) =>
        t.kind === "new" ? { kind: "new", name: entries[0]?.format === "pgAdmin" ? "From pgAdmin" : "Imported" } : t,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importSelected() {
    if (!pending || pending.selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const summary = await api.importConnections(
        pending.path,
        [...pending.selected].sort((a, b) => a - b),
      );
      setImportResult(summary);
      setPending(null);
      await refreshProfiles();
      if (summary.created.length > 0) useSidebarLayoutStore.getState().placeConnections(summary.created, target);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(index: number) {
    setPending((p) => {
      if (!p) return p;
      const selected = new Set(p.selected);
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
      return { ...p, selected };
    });
  }

  const importable = pending?.entries.filter((e) => e.error === null) ?? [];
  const allSelected =
    importable.length > 0 && importable.every((e) => pending?.selected.has(e.index));

  function toggleAll() {
    setPending(
      (p) =>
        p && {
          ...p,
          selected: allSelected ? new Set() : new Set(importable.map((e) => e.index)),
        },
    );
  }

  function setExportChecked(ids: string[], on: boolean) {
    setExportedCount(null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  return {
    selected,
    setExportChecked,
    target,
    setTarget,
    includeSecrets,
    setIncludeSecrets,
    busy,
    error,
    exportedCount,
    pending,
    importResult,
    importableCount: importable.length,
    allSelected,
    exportToFile,
    chooseImportFile,
    importSelected,
    toggle,
    toggleAll,
  };
}
