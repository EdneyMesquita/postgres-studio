import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri";
import { formatBytes } from "@/lib/format";
import { confirm } from "@/store/confirmStore";
import { databaseKey, useExplorerStore } from "@/store/explorerStore";
import { useConnectionsStore } from "@/store/connectionsStore";
import type { ScriptTarget } from "@/store/transferStore";
import type { ScriptOptions, ScriptProgress, ScriptSummary, SqlFileInfo } from "@/types/pg";
import { listenToRun, useElapsed } from "./progress";

export type ScriptPhase = "setup" | "running" | "done";

export interface PickedFile extends SqlFileInfo {
  path: string;
}

/** A SQL file, its options, and a run of it with progress. */
export function useScriptRun(target: ScriptTarget) {
  const [file, setFile] = useState<PickedFile | null>(null);
  const [options, setOptions] = useState<ScriptOptions>({ stopOnError: true, singleTransaction: false });
  const [phase, setPhase] = useState<ScriptPhase>("setup");
  const [progress, setProgress] = useState<ScriptProgress | null>(null);
  const [summary, setSummary] = useState<ScriptSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const executionId = useRef<string | null>(null);
  const elapsedMs = useElapsed(phase === "running");

  async function chooseFile() {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "SQL", extensions: ["sql"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!picked || Array.isArray(picked)) return;
    setError(null);
    try {
      setFile({ path: picked, ...(await api.sqlFileInfo(picked)) });
    } catch (e) {
      setFile(null);
      setError(String(e));
    }
  }

  function setSingleTransaction(singleTransaction: boolean) {
    // The first error aborts a transaction, so the rest could not run.
    setOptions((o) => ({ ...o, singleTransaction, stopOnError: singleTransaction ? true : o.stopOnError }));
  }

  async function start() {
    if (!file) return;
    const ok = await confirm({
      title: "Run this file?",
      message:
        `${file.name} (${formatBytes(file.sizeBytes)}) runs on ${target.database} of ${target.connection.name}. ` +
        (options.singleTransaction
          ? "It runs in one transaction, so an error undoes all of it."
          : "Statements that already ran stay applied, whatever happens after them."),
      confirmLabel: "Run",
      danger: true,
    });
    if (!ok) return;

    const id = crypto.randomUUID();
    executionId.current = id;
    setPhase("running");
    setError(null);
    setSummary(null);
    setProgress({ executionId: id, statementsDone: 0, bytesRead: 0, totalBytes: file.sizeBytes, errors: 0, currentPreview: "" });
    const unlisten = await listenToRun<ScriptProgress>("script-progress", id, setProgress);
    try {
      setSummary(await api.runSqlFile(target.sessionId, target.database, file.path, options, id));
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      executionId.current = null;
      setPhase("done");
      refreshExplorer(target);
    }
  }

  function cancel() {
    if (executionId.current) void api.cancelQuery(executionId.current);
  }

  /** Back to choosing a file, for another run. */
  function reset() {
    setFile(null);
    setSummary(null);
    setError(null);
    setProgress(null);
    setPhase("setup");
  }

  return { file, options, setOptions, setSingleTransaction, phase, progress, summary, error, elapsedMs, chooseFile, start, cancel, reset };
}

/** A script may have created or dropped anything: list the database again. */
function refreshExplorer({ connection, sessionId, database }: ScriptTarget) {
  const explorer = useExplorerStore.getState();
  void explorer.refreshDatabase(connection.id, sessionId, database).then(() => {
    const node = useExplorerStore.getState().databases[databaseKey(connection.id, database)];
    for (const schema of node?.schemas ?? []) {
      void explorer.refreshSchema(connection.id, sessionId, database, schema.name);
    }
  });
  void useConnectionsStore.getState().refreshDatabases(connection.id);
}

