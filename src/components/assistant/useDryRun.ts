import { useEffect, useState } from "react";
import { api } from "../../lib/tauri";
import type { Proposal } from "../../lib/assistant/answer";
import { useConnectionsStore } from "../../store/connectionsStore";
import { splitTable } from "./proposalActions";

export type DryRun =
  | { state: "running" }
  | { state: "done"; count: number; capped: boolean; ms: number }
  | { state: "skipped"; reason: string }
  | { state: "error"; message: string };

// One run per proposal, whichever card or strip asks, for the app's life.
const runs = new Map<string, Promise<DryRun>>();

async function dryRun(sessionId: string, database: string, table: string, proposal: Proposal): Promise<DryRun> {
  if (!proposal.code.trim()) return { state: "error", message: "Empty condition" };
  const started = performance.now();
  try {
    const { schema, table: name } = splitTable(table);
    const count = await api.countRows(sessionId, database, schema, name, proposal.code);
    return { state: "done", count, capped: false, ms: Math.round(performance.now() - started) };
  } catch (e) {
    return { state: "error", message: String(e) };
  }
}

/**
 * Counts the rows a proposed WHERE condition matches, once, read-only, so
 * the card can say what it returns before anything is applied. SQL
 * proposals aren't dry-run: they may write.
 */
export function useDryRun(connectionId: string, database: string, table: string | null, proposal: Proposal): DryRun | null {
  const sessionId = useConnectionsStore((s) => s.sessions[connectionId]?.sessionId);
  const [result, setResult] = useState<DryRun | null>(null);
  const skip = proposal.kind === "script" || !table || !sessionId;
  // By value: callers may build the proposal afresh on every render.
  const { kind, code } = proposal;

  useEffect(() => {
    if (skip) return;
    let live = true;
    const key = [sessionId, database, table, kind, code].join("\u0000");
    let run = runs.get(key);
    if (!run) {
      run = dryRun(sessionId, database, table, { kind, table, code });
      runs.set(key, run);
    }
    setResult({ state: "running" });
    void run.then((r) => live && setResult(r));
    return () => {
      live = false;
    };
  }, [skip, sessionId, database, table, kind, code]);

  return skip ? null : result;
}

export function dryRunText(run: DryRun, noun = "rows"): string {
  if (run.state === "running") return "Dry run…";
  if (run.state === "skipped") return run.reason;
  if (run.state === "error") return `Dry run failed: ${run.message}`;
  const n = `${run.count.toLocaleString("en")}${run.capped ? "+" : ""}`;
  return `Dry run: ${n} ${run.count === 1 && !run.capped ? noun.replace(/s$/, "") : noun} · ${run.ms} ms`;
}
