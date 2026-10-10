import type { ActivityRow } from "../types/objects";

export interface ActivityFilter {
  /** Leaves out sessions doing nothing: `idle` and background processes at rest. */
  hideIdle: boolean;
  /** Only the sessions on this database. */
  database: string | null;
  /** Keeps the autovacuum, WAL writer and other server processes. */
  showBackground: boolean;
}

const isClient = (r: ActivityRow) => r.backendType === null || r.backendType === "client backend";

/** The rows a filter lets through, in the order a DBA reads them. */
export function filterActivity(rows: ActivityRow[], f: ActivityFilter): ActivityRow[] {
  return rows
    .filter((r) => {
      if (!f.showBackground && !isClient(r)) return false;
      if (f.hideIdle && r.state === "idle") return false;
      if (f.database !== null && r.database !== f.database) return false;
      return true;
    })
    .sort((a, b) => stateRank(a) - stateRank(b) || (b.queryAgeMs ?? 0) - (a.queryAgeMs ?? 0) || a.pid - b.pid);
}

/** Active first, then sessions stuck in a transaction, then the rest. */
function stateRank(r: ActivityRow): number {
  if (r.state === "active") return 0;
  if (r.state?.startsWith("idle in transaction")) return 1;
  if (r.state === "idle") return 3;
  return 2;
}

/** `95400` -> `1m 35s`; under a second in ms, under a minute in seconds. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The query on one line, cut to `max` characters. */
export function oneLine(query: string | null, max: number): string {
  const text = (query ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
