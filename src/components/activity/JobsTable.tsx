import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/activity";
import { clockMs, relativeTime, timeOf } from "@/lib/jobs";
import { shortInterval } from "@/lib/timescale";
import { cn } from "@/lib/utils";
import type { JobInfo } from "../../types/timescale";

// the same classes as the sessions and locks tables in ActivityTabView, which imports this file
const th = "sticky top-0 z-[2] h-[30px] bg-panel px-3 text-left text-sm font-medium whitespace-nowrap text-fg-2 border-b border-line";
const td = "h-[28px] border-b border-line-soft px-3 align-middle whitespace-nowrap";

/** What the job works on: its hypertable or continuous aggregate, else its procedure. */
function targetOf(j: JobInfo): string {
  if (j.targetSchema && j.targetName) return `${j.targetSchema}.${j.targetName}`;
  return `${j.procSchema}.${j.procName}`;
}

/** A job is paused when the scheduler won't start it: unscheduled, or paused by hand. */
export function isPaused(j: JobInfo): boolean {
  return !j.scheduled || j.jobStatus === "Paused";
}

/** The server's background jobs, one row each; the failed ones are sorted first by the caller. */
export function JobsTable({ jobs, selected, onSelect }: { jobs: JobInfo[]; selected: number | null; onSelect: (jobId: number) => void }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={th}>ID</th>
          <th className={th}>Job</th>
          <th className={th}>Target</th>
          <th className={th}>Schedule</th>
          <th className={th}>Last run</th>
          <th className={th}>Next run</th>
          <th className={cn(th, "text-right")}>Failures</th>
          <th className={cn(th, "w-full")}>Last error</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <JobRow key={j.jobId} j={j} selected={j.jobId === selected} onSelect={() => onSelect(j.jobId)} />
        ))}
      </tbody>
    </table>
  );
}

function JobRow({ j, selected, onSelect }: { j: JobInfo; selected: boolean; onSelect: () => void }) {
  const failed = j.lastRunStatus === "Failed";
  const duration = clockMs(j.lastRunDuration);
  const paused = isPaused(j);
  return (
    <tr className={cn("cursor-default hover:bg-row-hover", selected && "bg-sel hover:bg-sel")} onClick={onSelect}>
      <td className={cn(td, "font-data tabular-nums")}>{j.jobId}</td>
      <td className={cn(td, "max-w-[220px] truncate")} title={j.applicationName}>
        {j.applicationName}
        <span className="ml-1.5 text-xs text-fg-3">{j.kind}</span>
      </td>
      <td className={cn(td, "max-w-[220px] truncate font-data text-fg-2")} title={targetOf(j)}>
        {targetOf(j)}
      </td>
      <td className={cn(td, "font-data text-fg-2")}>
        {shortInterval(j.scheduleInterval)}
        {paused && <span className="ml-1.5 rounded-sm bg-warn/15 px-1.5 py-0.5 text-xs text-warn">paused</span>}
      </td>
      <td className={td} title={j.lastRunStartedAt ?? undefined}>
        {j.lastRunStatus ? (
          <span className={cn("rounded-sm px-1.5 py-0.5 text-xs", failed ? "bg-danger/15 text-danger" : "bg-ok/15 text-ok")}>
            {j.lastRunStatus}
          </span>
        ) : (
          <span className="text-fg-3">never ran</span>
        )}
        <span className="ml-1.5 text-fg-3">{relativeTime(j.lastRunStartedAt)}</span>
        {duration !== null && <span className="ml-1.5 text-fg-2 tabular-nums">{formatDuration(duration)}</span>}
      </td>
      <td className={cn(td, "text-fg-2 tabular-nums")} title={j.nextStart ?? undefined}>
        {paused || timeOf(j.nextStart) === null ? "" : relativeTime(j.nextStart)}
      </td>
      <td className={cn(td, "text-right tabular-nums", (j.totalFailures ?? 0) > 0 && "text-danger")}>
        {j.totalFailures ?? 0} of {j.totalRuns ?? 0}
      </td>
      <td className={cn(td, "max-w-0", j.lastError ? "text-danger" : "text-fg-3")} title={j.lastError ?? undefined}>
        <span className="block truncate">{j.lastError ?? (failed ? "hidden: only the job's owner sees it" : "")}</span>
      </td>
    </tr>
  );
}

/** The job's config, owner and last error, with its actions. */
export function JobDetail({
  job,
  blocked,
  onAction,
}: {
  job: JobInfo;
  /** Why the actions can't run here, or null. */
  blocked: string | null;
  onAction: (action: "run" | "pause" | "resume") => void;
}) {
  const running = job.jobStatus === "Running";
  const paused = isPaused(job);
  const runTitle = blocked ?? (running ? "The job is running now" : "Start the job now, outside its schedule");
  return (
    <div className="flex max-h-[34%] min-h-[88px] flex-none flex-col border-t border-line">
      <div className="flex h-8 flex-none items-center gap-2 border-b border-line-soft pr-1.5 pl-3 text-sm text-fg-2">
        <span className="font-medium text-fg">Job {job.jobId}</span>
        <span className="truncate">{[job.applicationName, job.owner && `owner ${job.owner}`].filter(Boolean).join(" · ")}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" disabled={blocked !== null || running} title={runTitle} onClick={() => onAction("run")}>
          <Play />
          Run now
        </Button>
        {paused ? (
          <Button variant="ghost" size="sm" disabled={blocked !== null} title={blocked ?? "Let the scheduler run it again"} onClick={() => onAction("resume")}>
            <Play />
            Resume
          </Button>
        ) : (
          <Button variant="ghost" size="sm" disabled={blocked !== null} title={blocked ?? "Stop the scheduler starting it"} onClick={() => onAction("pause")}>
            <Pause />
            Pause
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 text-sm">
        <dl className="m-0 grid grid-cols-[120px_1fr] gap-x-4 gap-y-1">
          <dt className="text-fg-3">Procedure</dt>
          <dd className="m-0 font-data">{`${job.procSchema}.${job.procName}`}</dd>
          <dt className="text-fg-3">Target</dt>
          <dd className="m-0 font-data">{targetOf(job)}</dd>
          <dt className="text-fg-3">Schedule</dt>
          <dd className="m-0">{shortInterval(job.scheduleInterval)}</dd>
          <dt className="text-fg-3">Runs</dt>
          <dd className="m-0 tabular-nums">
            {job.totalRuns ?? 0} runs, {job.totalFailures ?? 0} failed
          </dd>
          <dt className="text-fg-3">Last error</dt>
          <dd className="m-0 text-danger">
            {job.lastError ? (
              <>
                <span className="whitespace-pre-wrap font-data">{job.lastError}</span>
                {job.lastErrorAt && <span className="ml-2 text-fg-3">{relativeTime(job.lastErrorAt)}</span>}
              </>
            ) : (
              <span className="text-fg-3">{job.lastRunStatus === "Failed" ? "Only the job's owner can read the error." : "None."}</span>
            )}
          </dd>
        </dl>
        <p className="mt-3 mb-1 text-fg-3">Config</p>
        <pre className="m-0 font-data whitespace-pre-wrap text-fg-2">
          {job.config && Object.keys(job.config).length > 0 ? JSON.stringify(job.config, null, 2) : "(none)"}
        </pre>
      </div>
    </div>
  );
}
