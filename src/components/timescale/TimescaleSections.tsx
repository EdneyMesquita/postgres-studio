import { Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { ActionMenuButton } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { compactDate } from "@/lib/chunkChart";
import { formatBytes } from "@/lib/format";
import { compressionRatio, formatRatio, shortInterval } from "@/lib/timescale";
import { columnstorePolicySql, refreshPolicySql, removePolicySql, retentionPolicySql } from "@/lib/timescaleSql";
import { cn } from "@/lib/utils";
import type { TableTab } from "../../store/sessionsStore";
import type { CaggDetail, Dimension, HypertableDetail, JobInfo } from "../../types/timescale";
import { openSql } from "../objects/openSql";
import { RelationLink, Section, td, th } from "../table/structureParts";
import { ChunkSizeChart } from "./ChunkSizeChart";
import { ChunksTable } from "./ChunksTable";
import { DropChunksDialog } from "./DropChunksDialog";
import { RefreshCaggDialog } from "./RefreshCaggDialog";
import { runTimescaleAction } from "./runAction";
import type { TimescaleDetail } from "./useTimescaleDetail";

interface Props {
  tab: TableTab;
  ts: TimescaleDetail;
}

const chip = "mr-1 rounded-sm bg-fg/7 px-1.5 py-0.5 font-mono text-sm";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-6 items-baseline gap-3 py-0.5">
      <span className="w-36 shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 text-fg-2">{children}</span>
    </div>
  );
}

function kindOf(detail: TimescaleDetail["detail"], kind: "hypertable" | "cagg") {
  if (!detail) return null;
  return kind === "hypertable" ? (detail as HypertableDetail) : (detail as CaggDetail);
}

function dimensionText(d: Dimension): string {
  if (d.kind === "Space") return `hash × ${d.numPartitions ?? "?"}`;
  if (d.timeInterval) return `chunks of ${shortInterval(d.timeInterval)}`;
  if (d.integerInterval !== null) return `chunks of ${d.integerInterval.toLocaleString("en-US")}`;
  return "";
}

/** "N chunks, M in columnstore" or "bucket 1 h · from <source>" beside rows and size. */
export function TimescaleHeaderExtras({ tab, ts }: Props) {
  const info = tab.info;
  if (info?.hypertable) {
    const h = info.hypertable;
    return (
      <span>
        {h.numChunks} chunks
        {h.columnstore && `, ${h.compressedChunks} in columnstore`}
      </span>
    );
  }
  if (info?.cagg) {
    const c = info.cagg;
    return (
      <span>
        {c.bucketWidth && <>bucket {shortInterval(c.bucketWidth)} · </>}from{" "}
        <RelationLink title={`Open ${c.sourceSchema}.${c.sourceName}`} onClick={() => ts.open(c.sourceSchema, c.sourceName, c.sourceKind === "cagg" ? "v" : "r")}>
          {c.sourceSchema === tab.schema ? c.sourceName : `${c.sourceSchema}.${c.sourceName}`}
        </RelationLink>
      </span>
    );
  }
  if (info?.chunk) {
    const p = info.chunk;
    return (
      <span>
        chunk of{" "}
        <RelationLink title={`Open ${p.hypertableSchema}.${p.hypertableName}`} onClick={() => ts.open(p.hypertableSchema, p.hypertableName, "r")}>
          {p.hypertableSchema}.{p.hypertableName}
        </RelationLink>
        {p.isCompressed && " · columnstore"}
      </span>
    );
  }
  return null;
}

/** What goes above the columns: the hypertable's or the aggregate's own settings. */
export function TimescaleHead({ tab, ts }: Props) {
  if (tab.info?.hypertable) return <HypertableSection tab={tab} ts={ts} />;
  if (tab.info?.cagg) return <CaggSection tab={tab} ts={ts} />;
  return null;
}

/** What goes after the indexes: chunk sizes, chunks, policies and the aggregates built on it. */
export function TimescaleTail({ tab, ts }: Props) {
  const info = tab.info;
  if (!info?.hypertable && !info?.cagg) return null;
  const hyper = info.hypertable ? (kindOf(ts.detail, "hypertable") as HypertableDetail | null) : null;
  const cagg = info.cagg ? (kindOf(ts.detail, "cagg") as CaggDetail | null) : null;
  const chunks = hyper?.chunks ?? cagg?.chunks ?? [];
  const canConvert = !!(info.hypertable?.columnstore || info.cagg?.columnstore);

  return (
    <>
      {ts.error && <p className="border-t border-line-soft px-3.5 py-2 text-sm text-danger">{ts.error}</p>}
      {chunks.length >= 2 && (
        <Section title="Chunk sizes">
          <ChunkSizeChart chunks={chunks} />
        </Section>
      )}
      {chunks.length > 0 && (
        <Section title="Chunks" count={chunks.length}>
          <ChunksTable chunks={chunks} ts={ts} canConvert={canConvert} />
        </Section>
      )}
      {hyper && <PoliciesSection tab={tab} ts={ts} detail={hyper} />}
      {hyper && hyper.caggs.length > 0 && (
        <Section title="Continuous aggregates" count={hyper.caggs.length}>
          <div className="border-b border-line-soft px-3.5 py-2 text-sm">
            {hyper.caggs.map((c) => (
              <div key={`${c.schema}.${c.name}`} className="py-0.5">
                <RelationLink title={`Open ${c.schema}.${c.name}`} onClick={() => ts.open(c.schema, c.name, "v")}>
                  {c.schema}.{c.name}
                </RelationLink>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function HypertableSection({ tab, ts }: Props) {
  const [dropOpen, setDropOpen] = useState(false);
  const h = tab.info!.hypertable!;
  const detail = kindOf(ts.detail, "hypertable") as HypertableDetail | null;
  const totals = detail?.totals;
  const ratio = totals ? compressionRatio(totals.beforeBytes, totals.afterBytes) : null;
  const dropBlock = ts.block(false);

  return (
    <Section
      title="Hypertable"
      action={
        <Button variant="ghost" size="sm" disabled={!!dropBlock} title={dropBlock ?? "Drop the chunks older than a point in time"} onClick={() => setDropOpen(true)}>
          Drop chunks…
        </Button>
      }
    >
      <div className="border-b border-line-soft px-3.5 py-2 text-sm">
        <Row label="Partitioned by">
          {h.dimensions.map((d) => (
            <span key={d.number} className="mr-3 whitespace-nowrap">
              <span className="font-data text-fg">{d.column}</span> <span className="font-data text-json-bson">{d.columnType}</span>{" "}
              <span className="text-fg-3">{dimensionText(d)}</span>
            </span>
          ))}
        </Row>
        <Row label="Columnstore">
          {!h.columnstore ? (
            <span className="text-fg-3">Columnstore off</span>
          ) : detail?.settings ? (
            <>
              <span className="mr-1 text-xs text-fg-3">segment by</span>
              {detail.settings.segmentby.length ? detail.settings.segmentby.map((c) => <span key={c} className={chip}>{c}</span>) : <span className="mr-2 text-fg-3">none</span>}
              <span className="mr-1 ml-2 text-xs text-fg-3">order by</span>
              {detail.settings.orderby.length ? detail.settings.orderby.map((c) => <span key={c} className={chip}>{c}</span>) : <span className="text-fg-3">none</span>}
            </>
          ) : (
            "On"
          )}
        </Row>
        {h.columnstore && (
          <Row label="Compression">
            {totals && totals.beforeBytes !== null && totals.afterBytes !== null ? (
              <span className="tabular-nums">
                {formatBytes(totals.beforeBytes)} → {formatBytes(totals.afterBytes)}
                {ratio !== null && ` (${formatRatio(ratio)})`}
                <span className="text-fg-3">
                  {" "}
                  across {totals.compressedChunks} of {totals.totalChunks} chunks
                </span>
              </span>
            ) : (
              <span className="text-fg-3">
                {h.compressedChunks} of {h.numChunks} chunks in columnstore
              </span>
            )}
          </Row>
        )}
      </div>
      {dropOpen && ts.target && (
        <DropChunksDialog
          target={ts.target}
          schema={tab.schema}
          name={tab.table}
          onClose={() => setDropOpen(false)}
          onDone={() => {
            setDropOpen(false);
            ts.done();
          }}
        />
      )}
    </Section>
  );
}

function jobValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return typeof v === "string" ? shortInterval(v) : String(v);
}

function jobConfig(job: JobInfo): string {
  const c = job.config ?? {};
  if (job.kind === "retention") return c.drop_after !== undefined ? `drop after ${jobValue(c.drop_after)}` : "";
  if (job.kind === "columnstore") {
    const after = c.compress_after ?? c.compress_created_before;
    return after !== undefined ? `convert after ${jobValue(after)}` : "";
  }
  if (job.kind === "refresh") {
    return `${jobValue(c.start_offset)} → ${c.end_offset === null || c.end_offset === undefined ? "newest" : jobValue(c.end_offset)} ago`;
  }
  return "";
}

const JOB_LABEL: Record<JobInfo["kind"], string> = {
  refresh: "Refresh",
  columnstore: "Columnstore",
  retention: "Retention",
  reorder: "Reorder",
  custom: "Custom",
  internal: "Internal",
};

function RunStatus({ job }: { job: JobInfo }) {
  if (job.jobStatus === "Paused" || !job.scheduled) return <span className="text-warn">Paused</span>;
  if (job.lastRunStatus === "Failed") {
    return (
      <span className="text-danger" title={job.lastError ?? undefined}>
        Failed{job.lastRunStartedAt ? ` ${compactDate(job.lastRunStartedAt)}` : ""}
      </span>
    );
  }
  if (job.lastRunStatus === "Success") return <span className="text-ok">Success{job.lastRunStartedAt ? ` ${compactDate(job.lastRunStartedAt)}` : ""}</span>;
  return <span className="text-fg-3">Never run</span>;
}

function jobEntries({ tab, ts }: Props) {
  const block = ts.block(true);
  async function run(job: JobInfo, what: "run" | "pause" | "resume") {
    if (!ts.target) return;
    const name = `job ${job.jobId} (${job.procName})`;
    const ok = await runTimescaleAction(
      ts.target,
      { kind: what === "run" ? "runJob" : what === "pause" ? "pauseJob" : "resumeJob", jobId: job.jobId },
      {
        label: `${what === "run" ? "Run" : what === "pause" ? "Pause" : "Resume"} ${name}`,
        ask:
          what === "run"
            ? { title: "Run the job now?", detail: `Runs ${name} once, outside its schedule.`, confirmLabel: "Run now" }
            : what === "pause"
              ? { title: "Pause the job?", detail: `${name} won't run on its schedule until it is resumed.`, confirmLabel: "Pause" }
              : undefined,
      },
    );
    if (ok) ts.done();
  }
  function entries(job: JobInfo): MenuEntry[] {
    const paused = job.jobStatus === "Paused" || !job.scheduled;
    const removable = job.kind === "retention" || job.kind === "columnstore" || job.kind === "refresh";
    return [
      { heading: `${JOB_LABEL[job.kind]} · job ${job.jobId}` },
      ...(block ? [{ heading: block }] : []),
      { label: "Run now", icon: Play, disabled: !!block, onSelect: () => void run(job, "run") },
      paused
        ? { label: "Resume", icon: RefreshCw, disabled: !!block, onSelect: () => void run(job, "resume") }
        : { label: "Pause", icon: Pause, disabled: !!block, onSelect: () => void run(job, "pause") },
      ...(removable
        ? [
            { separator: true as const },
            {
              label: "Remove…",
              icon: Trash2,
              danger: true,
              onSelect: () => openSql(tab.connection, tab.database, removePolicySql(job.kind as "retention" | "columnstore" | "refresh", job.targetSchema ?? tab.schema, job.targetName ?? tab.table)),
            },
          ]
        : []),
    ];
  }
  return entries;
}

function PoliciesSection({ tab, ts, detail }: Props & { detail: HypertableDetail }) {
  const entries = jobEntries({ tab, ts });
  const community = ts.info?.community ?? false;
  const open = (sql: string) => openSql(tab.connection, tab.database, sql);
  const addEntries = (): MenuEntry[] => [
    { label: "Retention…", onSelect: () => open(retentionPolicySql(tab.schema, tab.table)) },
    ...(community ? [{ label: "Columnstore…", onSelect: () => open(columnstorePolicySql(tab.schema, tab.table)) }] : []),
  ];

  return (
    <Section
      title="Policies"
      count={detail.policies.length}
      action={
        <ActionMenuButton
          entries={addEntries}
          label="Add policy"
          align="end"
          trigger={
            <Button variant="ghost" size="sm" title="Generate the SQL for a policy in a console">
              <Plus />
              Add policy
            </Button>
          }
        />
      }
    >
      {detail.policies.length === 0 ? (
        <p className="px-3.5 py-2 text-sm text-fg-3">None</p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={th}>Policy</th>
              <th className={th}>Schedule</th>
              <th className={th}>Setting</th>
              <th className={th}>Last run</th>
              <th className={th}>Next run</th>
              <th className={cn(th, "w-9")} />
            </tr>
          </thead>
          <tbody>
            {detail.policies.map((j) => (
              <tr key={j.jobId} className="hover:bg-row-hover" title={j.lastError ?? undefined}>
                <td className={cn(td, "whitespace-nowrap")}>
                  {JOB_LABEL[j.kind]} <span className="text-xs text-fg-3">job {j.jobId}</span>
                </td>
                <td className={cn(td, "font-data text-fg-2")}>{j.scheduleInterval ? `every ${shortInterval(j.scheduleInterval)}` : ""}</td>
                <td className={cn(td, "font-data text-fg-2")}>{jobConfig(j)}</td>
                <td className={cn(td, "whitespace-nowrap")}>
                  <RunStatus job={j} />
                </td>
                <td className={cn(td, "font-data whitespace-nowrap text-fg-2")}>{j.jobStatus === "Paused" || !j.scheduled ? "—" : compactDate(j.nextStart)}</td>
                <td className={cn(td, "text-right")}>
                  <ActionMenuButton entries={() => entries(j)} label={`Actions for job ${j.jobId}`} align="end" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function CaggSection({ tab, ts }: Props) {
  const [refreshOpen, setRefreshOpen] = useState(false);
  const c = tab.info!.cagg!;
  const detail = kindOf(ts.detail, "cagg") as CaggDetail | null;
  const block = ts.block(true);
  const realtime = !c.materializedOnly;

  async function toggle(enabled: boolean) {
    if (!ts.target) return;
    const ok = await runTimescaleAction(
      ts.target,
      { kind: "setRealtime", schema: tab.schema, name: tab.table, enabled },
      {
        label: `${enabled ? "Turn on" : "Turn off"} real-time aggregation for ${tab.table}`,
        ask: {
          title: enabled ? "Turn on real-time aggregation?" : "Turn off real-time aggregation?",
          detail: enabled
            ? "Queries add the rows of the source that are not materialized yet, at query time: always current, a little slower."
            : "Queries read only what has been materialized: fast, but the newest rows are missing until the next refresh.",
          confirmLabel: enabled ? "Turn on" : "Turn off",
        },
      },
    );
    if (ok) ts.done();
  }

  return (
    <Section
      title="Continuous aggregate"
      action={
        <Button variant="primary" size="sm" disabled={!!block} title={block ?? "Refresh a range of buckets"} onClick={() => setRefreshOpen(true)}>
          <RefreshCw />
          Refresh range…
        </Button>
      }
    >
      <div className="border-b border-line-soft px-3.5 py-2 text-sm">
        <Row label="Real-time">
          <span className="inline-flex items-center gap-2">
            <Switch size="sm" checked={realtime} disabled={!!block} title={block ?? undefined} aria-label="Real-time aggregation" onCheckedChange={(v) => void toggle(v)} />
            <span className="text-fg-3">{realtime ? "adds the rows not materialized yet at query time" : "only what is materialized"}</span>
          </span>
        </Row>
        <Row label="Materialized">
          {!detail ? (
            <span className="text-fg-3">…</span>
          ) : detail.watermarkState === "ok" ? (
            <span className="font-data">
              up to {compactDate(detail.watermark)}
              {detail.lag && <span className="font-sans text-fg-3"> · lag {shortInterval(detail.lag)}</span>}
            </span>
          ) : detail.watermarkState === "never" ? (
            <span className="text-warn">Never refreshed — the aggregate is empty</span>
          ) : (
            <span className="text-fg-3" title="The role has no SELECT on the materialization, so its progress can't be read">
              Unavailable
            </span>
          )}
        </Row>
        <Row label="Refresh policy">
          {!detail ? (
            <span className="text-fg-3">…</span>
          ) : detail.policy ? (
            <>
              <span className="font-data">
                every {shortInterval(detail.policy.scheduleInterval)}, {jobConfig(detail.policy)}
              </span>{" "}
              · <RunStatus job={detail.policy} />
            </>
          ) : (
            <>
              <span className="text-fg-3">No refresh policy</span>
              {(ts.info?.community ?? false) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-2"
                  title="Generate the SQL in a console"
                  onClick={() => openSql(tab.connection, tab.database, refreshPolicySql(tab.schema, tab.table))}
                >
                  Add refresh policy…
                </Button>
              )}
            </>
          )}
        </Row>
        {detail && detail.children.length > 0 && (
          <Row label="Used by">
            {detail.children.map((r) => (
              <span key={`${r.schema}.${r.name}`} className="mr-3">
                <RelationLink title={`Open ${r.schema}.${r.name}`} onClick={() => ts.open(r.schema, r.name, "v")}>
                  {r.schema === tab.schema ? r.name : `${r.schema}.${r.name}`}
                </RelationLink>
              </span>
            ))}
          </Row>
        )}
      </div>
      {refreshOpen && ts.target && (
        <RefreshCaggDialog
          target={ts.target}
          schema={tab.schema}
          name={tab.table}
          summary={c}
          detail={detail}
          onClose={() => setRefreshOpen(false)}
          onDone={() => {
            setRefreshOpen(false);
            ts.done();
          }}
        />
      )}
    </Section>
  );
}
