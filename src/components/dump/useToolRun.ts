import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "@/lib/tauri";
import type { PgToolsInfo, ToolProgressEvent } from "@/types/pg";

/** Progress lines kept for the log area. */
const KEPT_LINES = 6;

/** What `cancelQuery` makes a stopped run reject with. */
export const CANCELLED = "cancelled";

/**
 * One pg_dump / pg_restore run at a time: its progress lines (the last few),
 * how many objects it handled, and the result or the error.
 */
export function useToolRun<T>(event: "dump-progress" | "restore-progress") {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [objects, setObjects] = useState(0);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const executionId = useRef<string | null>(null);

  useEffect(() => {
    const unlisten = listen<ToolProgressEvent>(event, (e) => {
      if (e.payload.executionId !== executionId.current) return;
      setLines((prev) => [...prev, e.payload.line].slice(-KEPT_LINES));
      setObjects(e.payload.objects);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [event]);

  const run = useCallback(async (start: (executionId: string) => Promise<T>) => {
    const id = crypto.randomUUID();
    executionId.current = id;
    setRunning(true);
    setLines([]);
    setObjects(0);
    setResult(null);
    setError(null);
    setCancelled(false);
    try {
      setResult(await start(id));
    } catch (e) {
      if (String(e) === CANCELLED) setCancelled(true);
      else setError(String(e));
    } finally {
      executionId.current = null;
      setRunning(false);
    }
  }, []);

  const cancel = useCallback(() => {
    if (executionId.current) void api.cancelQuery(executionId.current);
  }, []);

  return { running, lines, objects, result, error, cancelled, run, cancel };
}

/** The client tools found on this machine, looked up when the dialog opens. */
export function usePgTools() {
  const [tools, setTools] = useState<PgToolsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.pgToolsInfo().then(setTools, (e) => setError(String(e)));
  }, []);
  return { tools, error };
}

/** 17 for "17.11"; null when the server's version isn't known. */
export function majorOf(version: string | null | undefined): number | null {
  const major = parseInt(version ?? "", 10);
  return Number.isNaN(major) ? null : major;
}
