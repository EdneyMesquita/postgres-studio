import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

/**
 * Calls `handle` for the backend's progress events of one run. Resolves once
 * the listener is registered, so it can be awaited before the run starts.
 */
export function listenToRun<T extends { executionId: string }>(
  event: string,
  executionId: string,
  handle: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, ({ payload }) => {
    if (payload.executionId === executionId) handle(payload);
  });
}

/** Milliseconds since `running` turned true; holds its value once it stops. */
export function useElapsed(running: boolean): number {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = performance.now();
    setMs(0);
    const timer = setInterval(() => setMs(performance.now() - start), 250);
    return () => clearInterval(timer);
  }, [running]);
  return ms;
}

/** `65_000` -> `1m 05s`, `3_200` -> `3.2 s`. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
