import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, Copy, OctagonX, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useConnectionColor } from "@/lib/connectionColor";
import { filterActivity, formatDuration, oneLine } from "@/lib/activity";
import { errorsHidden, filterJobs } from "@/lib/jobs";
import { timescaleApi } from "@/lib/timescaleApi";
import { cn } from "@/lib/utils";
import { objectsApi } from "../../lib/objectsApi";
import { confirm } from "../../store/confirmStore";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { ActivityTab } from "../../store/sessionsStore";
import { timescaleActionBlock, useTimescaleInfo } from "../../store/timescaleInfo";
import type { ActivityRow, LockRow } from "../../types/objects";
import type { JobInfo } from "../../types/timescale";
import { SqlText } from "../console/SqlText";
import { runTimescaleAction } from "../timescale/runAction";
import { JobDetail, JobsTable } from "./JobsTable";

type View = "sessions" | "locks" | "jobs";

/** How often the lists are read again while auto-refresh is on. */
const REFRESH_MS = 2000;

const th = "sticky top-0 z-[2] h-[30px] bg-panel px-3 text-left text-sm font-medium whitespace-nowrap text-fg-2 border-b border-line";
const td = "h-[28px] border-b border-line-soft px-3 align-middle whitespace-nowrap";

const STATE_CLASS: Record<string, string> = {
  active: "text-ok",
  "idle in transaction": "text-warn",
  "idle in transaction (aborted)": "text-danger",
};

function Toggle({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-sm text-fg-2" title={title}>
      <Switch size="sm" checked={checked} onCheckedChange={onChange} />
      <span className="whitespace-nowrap">{label}</span>
    </label>
  );
}

/** The server's sessions, locks and TimescaleDB jobs, refreshed on a timer while the tab is on screen. */
export const ActivityTabView = memo(function ActivityTabView({ tab, shown }: { tab: ActivityTab; shown: boolean }) {
  const session = useConnectionsStore((s) => s.sessions[tab.connection.id]);
  const color = useConnectionColor(tab.connection.id);
  const sessionId = session?.sessionId;
  const readOnly = session?.readOnly ?? false;
  const info = useTimescaleInfo(tab.connection.id, sessionId, tab.database);
  const timescale = info !== null;

  const [view, setView] = useState<View>(tab.view ?? "sessions");
  const [hideIdle, setHideIdle] = useState(true);
  const [thisDatabase, setThisDatabase] = useState(false);
  const [showBackground, setShowBackground] = useState(false);
  const [allLocks, setAllLocks] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const [hideInternal, setHideInternal] = useState(true);
  const [auto, setAuto] = useState(true);
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [locks, setLocks] = useState<LockRow[] | null>(null);
  const [jobs, setJobs] = useState<JobInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [selectedJob, setSelectedJob] = useState<number | null>(null);
  const inFlight = useRef(false);

  // openActivity on a tab already open sets its view again; the tab keeps
  // the one in use, so only a real request changes it
  useEffect(() => {
    if (tab.view) setView(tab.view);
  }, [tab.view]);

  const load = useCallback(async () => {
    if (!sessionId || inFlight.current) return;
    if (view === "jobs" && !timescale) return;
    inFlight.current = true;
    setLoading(true);
    try {
      if (view === "sessions") setRows(await objectsApi.serverActivity(sessionId, tab.database));
      else if (view === "locks") setLocks(await objectsApi.serverLocks(sessionId, tab.database, allLocks));
      else setJobs(await timescaleApi.jobs(sessionId, tab.database));
      setError(null);
      setUpdated(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [sessionId, tab.database, view, allLocks, timescale]);

  // read when opened, and when the view or its scope changes
  useEffect(() => {
    void load();
  }, [load]);

  // The timer runs only while the tab is on screen and the window is visible.
  useEffect(() => {
    if (!auto || !shown) return;
    const tick = () => {
      if (!document.hidden) void load();
    };
    const timer = setInterval(tick, REFRESH_MS);
    // catch up at once on coming back to the tab or the window
    document.addEventListener("visibilitychange", tick);
    tick();
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [auto, shown, load]);

  const shownRows = useMemo(
    () => filterActivity(rows ?? [], { hideIdle, database: thisDatabase ? tab.database : null, showBackground }),
    [rows, hideIdle, thisDatabase, showBackground, tab.database],
  );
  const selectedRow = shownRows.find((r) => r.pid === selected) ?? null;
  const shownJobs = useMemo(() => filterJobs(jobs ?? [], { failedOnly, hideInternal }), [jobs, failedOnly, hideInternal]);
  const selectedJobRow = shownJobs.find((j) => j.jobId === selectedJob) ?? null;
  const actionBlock = timescaleActionBlock(info, readOnly, false);

  async function stop(pid: number, user: string | null, query: string | null, own: boolean, terminate: boolean) {
    if (!sessionId) return;
    if (terminate) {
      const ok = await confirm({
        title: `Terminate session ${pid}?`,
        message:
          `Ends the connection of ${user ?? "a background process"}, rolling back what its transaction has done.` +
          (own ? " This is one of Postgres Studio's own sessions: the tab or console using it will lose its connection." : "") +
          (query ? ` It is running: ${oneLine(query, 100)}` : ""),
        confirmLabel: "Terminate session",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      const signalled = await objectsApi.signalBackend(sessionId, tab.database, pid, terminate);
      if (signalled) toast.success(terminate ? `Terminated session ${pid}` : `Cancelled the query of ${pid}`);
      else toast.warning(`The server did not signal ${pid}`, { description: "It has already ended, or your role may not signal it." });
    } catch (e) {
      toast.error(`Couldn't ${terminate ? "terminate" : "cancel"} ${pid}`, { description: String(e) });
    }
    void load();
  }

  async function jobAction(job: JobInfo, action: "run" | "pause" | "resume") {
    if (!sessionId) return;
    const target = { sessionId, database: tab.database };
    const { jobId } = job;
    if (action === "run") {
      await runTimescaleAction(target, { kind: "runJob", jobId }, {
        label: `Run job ${jobId}`,
        ask: {
          title: `Run job ${jobId} now?`,
          detail: "The scheduler starts it right away; its outcome shows up here and in the job's history.",
          confirmLabel: "Run now",
        },
      });
    } else if (action === "pause") {
      await runTimescaleAction(target, { kind: "pauseJob", jobId }, {
        label: `Pause job ${jobId}`,
        ask: {
          title: `Pause job ${jobId}?`,
          detail: "The scheduler stops starting it until it is resumed.",
          confirmLabel: "Pause",
        },
      });
    } else {
      await runTimescaleAction(target, { kind: "resumeJob", jobId }, { label: `Resume job ${jobId}` });
    }
    void load();
  }

  if (!sessionId) {
    return <div className="grid h-full place-items-center bg-editor text-sm text-fg-3">{tab.connection.name} is not connected.</div>;
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-editor">
      <div className="flex h-9 flex-none items-center gap-3 overflow-hidden border-b border-line pr-2 pl-2.5">
        <span
          className="inline-flex h-[26px] min-w-0 shrink items-center gap-1.5 rounded-md bg-fg/6 px-2 text-sm text-fg-2"
          title={`Activity of the server behind ${tab.database} on ${tab.connection.name}`}
        >
          <ConnectionChip name={tab.connection.name} color={color} size="sm" />
          <span className="truncate font-data font-medium text-fg">{tab.database}</span>
        </span>
        <SegmentedControl<View>
          aria-label="View"
          value={view}
          onChange={(v) => {
            setView(v);
            setSelectedJob(null);
            useSessionsStore.setState((s) => ({
              tabs: s.tabs.map((t) => (t.id === tab.id && t.kind === "activity" ? { ...t, view: v } : t)),
            }));
          }}
          options={[
            { value: "sessions", label: "Sessions" },
            { value: "locks", label: "Locks" },
            ...(timescale ? [{ value: "jobs" as const, label: "Jobs" }] : []),
          ]}
        />
        {view === "sessions" ? (
          <>
            <Toggle label="Hide idle" checked={hideIdle} onChange={setHideIdle} title="Leave out sessions doing nothing" />
            <Toggle label="This database only" checked={thisDatabase} onChange={setThisDatabase} />
            <Toggle label="Background" checked={showBackground} onChange={setShowBackground} title="Show the server's own processes: autovacuum, WAL writer..." />
          </>
        ) : view === "jobs" ? (
          <>
            <Toggle label="Failed only" checked={failedOnly} onChange={setFailedOnly} title="Only the jobs whose last run failed" />
            <Toggle label="Hide internal" checked={hideInternal} onChange={setHideInternal} title="Leave out TimescaleDB's own jobs: telemetry, job history retention" />
          </>
        ) : (
          <Toggle label="All locks" checked={allLocks} onChange={setAllLocks} title="Off: only locks that wait or are waited on" />
        )}
        <span className="flex-1" />
        <span className="truncate text-sm whitespace-nowrap text-fg-3 tabular-nums @max-[1040px]:hidden">
          {view === "sessions"
            ? rows
              ? `${shownRows.length} of ${rows.length} sessions`
              : ""
            : view === "jobs"
              ? jobs
                ? `${shownJobs.length} of ${jobs.length} jobs`
                : ""
              : locks
                ? `${locks.length} locks`
                : ""}
          {updated && ` · ${updated.toLocaleTimeString()}`}
        </span>
        <Toggle label="Auto-refresh" checked={auto} onChange={setAuto} title={`Read again every ${REFRESH_MS / 1000} s while this tab is shown`} />
        <Button variant="ghost" title="Read again now" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn(loading && "animate-spin")} />
          <span className="@max-[900px]:hidden">Refresh</span>
        </Button>
      </div>

      {error && <p className="m-0 border-b border-line-soft px-3.5 py-2 text-sm text-danger">{error}</p>}
      {view === "jobs" && jobs && errorsHidden(jobs) && (
        <p className="m-0 border-b border-line-soft px-3.5 py-2 text-sm text-fg-3">Errors are only visible to the job's owner.</p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {view === "jobs" ? (
          !timescale ? (
            <p className="p-4 text-sm text-fg-3">Jobs need TimescaleDB in this database.</p>
          ) : jobs === null ? (
            <p className="p-4 text-sm text-fg-3">Loading…</p>
          ) : shownJobs.length === 0 ? (
            <p className="p-4 text-sm text-fg-3">{jobs.length === 0 ? "No jobs." : "No jobs match the filters."}</p>
          ) : (
            <JobsTable jobs={shownJobs} selected={selectedJob} onSelect={(id) => setSelectedJob(id === selectedJob ? null : id)} />
          )
        ) : view === "sessions" ? (
          rows === null ? (
            <p className="p-4 text-sm text-fg-3">Loading…</p>
          ) : shownRows.length === 0 ? (
            <p className="p-4 text-sm text-fg-3">No sessions match the filters.</p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={th}>PID</th>
                  <th className={th}>User</th>
                  <th className={th}>Database</th>
                  <th className={th}>Application</th>
                  <th className={th}>Client</th>
                  <th className={th}>State</th>
                  <th className={th}>Waiting on</th>
                  <th className={cn(th, "text-right")}>Transaction</th>
                  <th className={cn(th, "text-right")}>Query</th>
                  <th className={cn(th, "w-full")}>SQL</th>
                  <th className={cn(th, "w-16")} />
                </tr>
              </thead>
              <tbody>
                {shownRows.map((r) => (
                  <SessionRow key={r.pid} r={r} selected={r.pid === selected} onSelect={() => setSelected(r.pid === selected ? null : r.pid)} onStop={stop} />
                ))}
              </tbody>
            </table>
          )
        ) : locks === null ? (
          <p className="p-4 text-sm text-fg-3">Loading…</p>
        ) : locks.length === 0 ? (
          <p className="p-4 text-sm text-fg-3">{allLocks ? "No locks." : "Nothing waits for a lock."}</p>
        ) : (
          <LocksTable locks={locks} />
        )}
      </div>

      {view === "jobs" && selectedJobRow && (
        <JobDetail job={selectedJobRow} blocked={actionBlock} onAction={(action) => void jobAction(selectedJobRow, action)} />
      )}

      {view === "sessions" && selectedRow && (
        <div className="flex max-h-[34%] min-h-[88px] flex-none flex-col border-t border-line">
          <div className="flex h-8 flex-none items-center gap-2 border-b border-line-soft pr-1.5 pl-3 text-sm text-fg-2">
            <span className="font-medium text-fg">Session {selectedRow.pid}</span>
            <span className="truncate">
              {[selectedRow.user, selectedRow.application, selectedRow.clientAddr].filter(Boolean).join(" · ")}
            </span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="icon-sm"
              title="Copy the query"
              aria-label="Copy the query"
              onClick={() => void navigator.clipboard.writeText(selectedRow.query ?? "").then(() => toast.success("Copied the query"))}
            >
              <Copy />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
            <SqlText text={selectedRow.query || "(no query)"} className="whitespace-pre-wrap" />
          </div>
        </div>
      )}
    </div>
  );
});

function SessionRow({
  r,
  selected,
  onSelect,
  onStop,
}: {
  r: ActivityRow;
  selected: boolean;
  onSelect: () => void;
  onStop: (pid: number, user: string | null, query: string | null, own: boolean, terminate: boolean) => Promise<void>;
}) {
  const blocked = r.blockedBy.length > 0;
  const wait = r.waitEvent ? `${r.waitEventType}: ${r.waitEvent}` : "";
  const isClient = r.backendType === null || r.backendType === "client backend";
  return (
    <tr className={cn("group cursor-default hover:bg-row-hover", selected && "bg-sel hover:bg-sel")} onClick={onSelect}>
      <td className={cn(td, "font-data tabular-nums")}>{r.pid}</td>
      <td className={cn(td, "font-data")}>{r.user ?? <span className="text-fg-3">{r.backendType}</span>}</td>
      <td className={cn(td, "font-data text-fg-2")}>{r.database}</td>
      <td className={cn(td, "max-w-[180px] truncate text-fg-2")} title={r.application ?? undefined}>
        {r.application}
        {r.own && (
          <span className="ml-1.5 rounded-sm bg-accent/15 px-1.5 py-0.5 text-xs text-accent-text" title="One of this app's own sessions">
            this app
          </span>
        )}
      </td>
      <td className={cn(td, "font-data text-fg-2")}>{r.clientAddr}</td>
      <td className={cn(td, STATE_CLASS[r.state ?? ""] ?? "text-fg-2")}>
        {r.state}
        {blocked && (
          <span className="ml-1.5 rounded-sm bg-danger/15 px-1.5 py-0.5 text-xs text-danger" title="Waits for a lock these sessions hold">
            blocked by {r.blockedBy.join(", ")}
          </span>
        )}
      </td>
      <td className={cn(td, "text-fg-3")}>{wait}</td>
      <td className={cn(td, "text-right tabular-nums", (r.xactAgeMs ?? 0) > 60_000 && "text-warn")} title={r.xactStart ?? undefined}>
        {formatDuration(r.xactAgeMs)}
      </td>
      <td className={cn(td, "text-right tabular-nums")} title={r.queryStart ?? undefined}>
        {formatDuration(r.queryAgeMs)}
      </td>
      <td className={cn(td, "max-w-0 font-data text-fg-2")} title={r.query ?? undefined}>
        <span className="block truncate">{oneLine(r.query, 160)}</span>
      </td>
      <td className={cn(td, "text-right")}>
        {isClient && (
          <span className="inline-flex gap-0.5 opacity-60 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon-xs"
              title="Cancel the query (pg_cancel_backend)"
              aria-label={`Cancel the query of ${r.pid}`}
              disabled={r.state !== "active"}
              onClick={(e) => {
                e.stopPropagation();
                void onStop(r.pid, r.user, r.query, r.own, false);
              }}
            >
              <Ban />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title="Terminate the session (pg_terminate_backend)"
              aria-label={`Terminate session ${r.pid}`}
              className="hover:text-danger"
              onClick={(e) => {
                e.stopPropagation();
                void onStop(r.pid, r.user, r.query, r.own, true);
              }}
            >
              <OctagonX />
            </Button>
          </span>
        )}
      </td>
    </tr>
  );
}

function LocksTable({ locks }: { locks: LockRow[] }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={th}>PID</th>
          <th className={th}>User</th>
          <th className={th}>Type</th>
          <th className={th}>Mode</th>
          <th className={th}>Relation</th>
          <th className={th}>Status</th>
          <th className={cn(th, "text-right")}>Query for</th>
          <th className={cn(th, "w-full")}>SQL</th>
        </tr>
      </thead>
      <tbody>
        {locks.map((l, i) => (
          <tr key={`${l.pid}-${l.locktype}-${l.mode}-${l.relation}-${i}`} className={cn("hover:bg-row-hover", !l.granted && "bg-danger/6")}>
            <td className={cn(td, "font-data tabular-nums")}>
              {l.pid}
              {l.own && <span className="ml-1.5 rounded-sm bg-accent/15 px-1.5 py-0.5 text-xs text-accent-text">this app</span>}
            </td>
            <td className={cn(td, "font-data text-fg-2")}>{l.user}</td>
            <td className={cn(td, "text-fg-2")}>{l.locktype}</td>
            <td className={cn(td, "font-data")}>{l.mode}</td>
            <td className={cn(td, "font-data text-fg-2")}>{l.relation}</td>
            <td className={td}>
              {l.granted ? (
                l.blocking ? (
                  <span className="text-warn">held, others wait</span>
                ) : (
                  <span className="text-fg-3">granted</span>
                )
              ) : (
                <span className="text-danger">waiting on {l.blockedBy.length > 0 ? l.blockedBy.join(", ") : "…"}</span>
              )}
            </td>
            <td className={cn(td, "text-right tabular-nums")}>{formatDuration(l.queryAgeMs)}</td>
            <td className={cn(td, "max-w-0 font-data text-fg-2")} title={l.query ?? undefined}>
              <span className="block truncate">{oneLine(l.query, 160)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
