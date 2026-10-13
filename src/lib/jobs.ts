import type { JobInfo } from "../types/timescale";
import { formatDuration } from "./activity";

export interface JobFilter {
  /** Only the jobs whose last run failed. */
  failedOnly: boolean;
  /** Leaves out Timescale's own jobs: telemetry, job history retention. */
  hideInternal: boolean;
}

/** The jobs a filter lets through, in the order a DBA reads them. */
export function filterJobs(jobs: JobInfo[], f: JobFilter): JobInfo[] {
  return sortJobs(
    jobs.filter((j) => {
      if (f.failedOnly && j.lastRunStatus !== "Failed") return false;
      if (f.hideInternal && j.kind === "internal") return false;
      return true;
    }),
  );
}

/** Failed jobs first, then the ones due soonest; paused jobs with no next run go last. */
export function sortJobs(jobs: JobInfo[]): JobInfo[] {
  return [...jobs].sort((a, b) => {
    const failed = Number(b.lastRunStatus === "Failed") - Number(a.lastRunStatus === "Failed");
    if (failed !== 0) return failed;
    const next = (timeOf(a.nextStart) ?? Infinity) - (timeOf(b.nextStart) ?? Infinity);
    if (next !== 0 && !Number.isNaN(next)) return next;
    return a.jobId - b.jobId;
  });
}

/**
 * True when jobs failed but none shows an error. The server only shows a job's
 * last error to the job's owner, so the view says why.
 */
export function errorsHidden(jobs: JobInfo[]): boolean {
  const failed = jobs.filter((j) => j.lastRunStatus === "Failed");
  return failed.length > 0 && failed.every((j) => j.lastError === null);
}

/**
 * A timestamp as Postgres writes it text (`2026-10-13 03:23:09.773473+00`)
 * in milliseconds since the epoch, or null when there is none (`infinity`,
 * `null`, or text that doesn't read as a time). JS reads only millisecond
 * fractions and `+00:00` offsets, so both are rewritten first.
 */
export function timeOf(text: string | null): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(text?.trim() ?? "");
  if (!m) return null;
  const frac = (m[3] ?? ".000").slice(0, 4).padEnd(4, "0");
  const zone = m[4] ?? "Z";
  const offset = zone === "Z" ? "Z" : /^[+-]\d{2}$/.test(zone) ? `${zone}:00` : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(`${m[1]}T${m[2]}${frac}${offset}`);
  return Number.isNaN(ms) ? null : ms;
}

/** `00:00:00.460925` or `1 day 02:00:00` (an interval's clock form) in milliseconds, or null. */
export function clockMs(text: string | null): number | null {
  const m = /^(?:(\d+) days?\s+)?(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text?.trim() ?? "");
  if (!m) return null;
  const seconds = Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return Math.round(seconds * 1000);
}

/** `3 min ago` or `in 2h 05m`, from `now`; empty when the time is unknown. */
export function relativeTime(text: string | null, now: number = Date.now()): string {
  const at = timeOf(text);
  if (at === null) return "";
  const diff = at - now;
  if (Math.abs(diff) < 1000) return "just now";
  return diff < 0 ? `${formatDuration(-diff)} ago` : `in ${formatDuration(diff)}`;
}
