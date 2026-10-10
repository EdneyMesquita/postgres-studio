import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/tauri";
import { useConnectionsStore } from "@/store/connectionsStore";
import { useSessionsStore } from "@/store/sessionsStore";
import type { CsvTarget } from "@/store/transferStore";
import type { ColumnInfo, CsvImportSummary, CsvOptions, CsvPreview, CsvProgress } from "@/types/pg";
import { listenToRun, useElapsed } from "../scripts/progress";
import { autoMap, duplicateTargets, loadableColumns, missingRequired } from "./csvMapping";

export type CsvPhase = "setup" | "running" | "done";

export const DEFAULT_OPTIONS: CsvOptions = { delimiter: ",", quote: '"', header: true, nullString: "" };

/** Delimiters tried on a new file, in order of preference. */
const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"];

export interface PickedCsv {
  path: string;
  name: string;
}

/** The delimiter that splits the file into the most columns. */
async function detectDelimiter(path: string, options: CsvOptions): Promise<string> {
  let best = { delimiter: options.delimiter, columns: 0 };
  for (const delimiter of CANDIDATE_DELIMITERS) {
    try {
      const { columns } = await api.previewCsv(path, { ...options, delimiter });
      if (columns > best.columns) best = { delimiter, columns };
    } catch {
      // not readable with this one
    }
  }
  return best.delimiter;
}

/** A CSV file, how to read it, where its columns go, and the import itself. */
export function useCsvImport(target: CsvTarget) {
  const [file, setFile] = useState<PickedCsv | null>(null);
  const [options, setOptionsState] = useState<CsvOptions>(DEFAULT_OPTIONS);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  // What the user changed in the mapping; null follows the automatic one.
  const [manual, setManual] = useState<(string | null)[] | null>(null);
  const [phase, setPhase] = useState<CsvPhase>("setup");
  const [progress, setProgress] = useState<CsvProgress | null>(null);
  const [summary, setSummary] = useState<CsvImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const executionId = useRef<string | null>(null);
  const elapsedMs = useElapsed(phase === "running");
  const readOnly = useConnectionsStore((s) => s.sessions[target.connection.id]?.readOnly ?? false);

  useEffect(() => {
    let stale = false;
    api
      .describeTable(target.sessionId, target.database, target.schema, target.table)
      .then((info) => !stale && setColumns(info.columns))
      .catch((e) => !stale && setColumnsError(String(e)));
    return () => {
      stale = true;
    };
  }, [target.sessionId, target.database, target.schema, target.table]);

  // Read the first rows again whenever the file or the way to read it changes.
  useEffect(() => {
    if (!file) return;
    let stale = false;
    const timer = setTimeout(() => {
      api
        .previewCsv(file.path, options)
        .then((p) => {
          if (stale) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e) => {
          if (stale) return;
          setPreview(null);
          setPreviewError(String(e));
        });
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [file, options]);

  const targets = useMemo(() => loadableColumns(columns ?? []), [columns]);
  const automatic = useMemo(
    () => (preview ? autoMap(preview.headers, preview.columns, targets.map((c) => c.name)) : []),
    [preview, targets],
  );
  const mapping = manual && manual.length === automatic.length ? manual : automatic;
  const duplicates = useMemo(() => duplicateTargets(mapping), [mapping]);
  const missing = useMemo(() => (columns ? missingRequired(columns, mapping) : []), [columns, mapping]);
  const mappedCount = mapping.filter((m) => m !== null).length;

  async function chooseFile() {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "CSV", extensions: ["csv", "tsv", "txt"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!picked || Array.isArray(picked)) return;
    const delimiter = await detectDelimiter(picked, options);
    setManual(null);
    setPreview(null);
    setPreviewError(null);
    setOptionsState((o) => ({ ...o, delimiter }));
    setFile({ path: picked, name: picked.split(/[\\/]/).pop() ?? picked });
  }

  function setOptions(patch: Partial<CsvOptions>) {
    // The NULL text doesn't change the columns, so what was mapped stays.
    if (Object.keys(patch).some((k) => k !== "nullString")) setManual(null);
    setOptionsState((o) => ({ ...o, ...patch }));
  }

  function setTarget(fileColumn: number, column: string | null) {
    const next = [...mapping];
    next[fileColumn] = column;
    setManual(next);
  }

  const readyToImport =
    phase === "setup" && !readOnly && preview !== null && columns !== null && mappedCount > 0 && duplicates.size === 0;

  async function start() {
    if (!file || !readyToImport) return;
    const id = crypto.randomUUID();
    executionId.current = id;
    setPhase("running");
    setError(null);
    setSummary(null);
    setProgress({ executionId: id, bytesRead: 0, totalBytes: preview?.totalBytes ?? 0, rows: 0 });
    const unlisten = await listenToRun<CsvProgress>("csv-import-progress", id, setProgress);
    try {
      const done = await api.importCsv(target.sessionId, target.database, target.schema, target.table, file.path, mapping, options, id);
      setSummary(done);
      refreshOpenTable(target);
    } catch (e) {
      setError(String(e));
    } finally {
      unlisten();
      executionId.current = null;
      setPhase("done");
    }
  }

  function cancel() {
    if (executionId.current) void api.cancelQuery(executionId.current);
  }

  /** Back to the mapping, after an error. */
  function back() {
    setError(null);
    setProgress(null);
    setPhase("setup");
  }

  return {
    file,
    options,
    setOptions,
    preview,
    previewError,
    columns: targets,
    columnsError,
    mapping,
    setTarget,
    duplicates,
    missing,
    mappedCount,
    readOnly,
    readyToImport,
    phase,
    progress,
    summary,
    error,
    elapsedMs,
    chooseFile,
    start,
    cancel,
    back,
  };
}

/** The table's tab shows its old rows: load them again. */
function refreshOpenTable({ connection, sessionId, database, schema, table }: CsvTarget) {
  const sessions = useSessionsStore.getState();
  const tab = sessions.tabs.find(
    (t) => t.kind === "table" && t.connection.id === connection.id && t.database === database && t.schema === schema && t.table === table,
  );
  if (!tab) return;
  void sessions.runQuery(sessionId, tab.id);
  void sessions.loadInfo(sessionId, tab.id);
  void sessions.countRows(sessionId, tab.id);
}
