import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { formatInt } from "@/lib/format";
import { shortInterval } from "@/lib/timescale";
import { timescaleApi } from "@/lib/timescaleApi";
import { useConnectionsStore } from "../../store/connectionsStore";
import type { TabConnection } from "../../store/sessionsStore";
import { timescaleActionBlock, useTimescaleInfo } from "../../store/timescaleInfo";
import type { CaggDetail, CaggSummary } from "../../types/timescale";
import { SqlText } from "../console/SqlText";
import { runTimescaleAction } from "./runAction";
import { estimateBuckets, rangeForDays } from "./refreshRange";

export interface TimescaleTarget {
  connection: TabConnection;
  sessionId: string;
  database: string;
}

const PRESETS: { label: string; days: number | null }[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Everything", days: null },
];

/** The value settles to the input's text after a pause, so a preview isn't asked for every key. */
export function useDebounced(value: string, ms: number): string {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}

/**
 * Refreshes a continuous aggregate over a range: the way to fill in the
 * history of one created WITH NO DATA. Shows the statement it will run.
 */
export function RefreshCaggDialog({
  target,
  schema,
  name,
  summary,
  detail,
  onClose,
  onDone,
}: {
  target: TimescaleTarget;
  schema: string;
  name: string;
  summary: CaggSummary;
  detail: CaggDetail | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const info = useTimescaleInfo(target.connection.id, target.sessionId, target.database);
  const readOnly = useConnectionsStore((s) => s.sessions[target.connection.id]?.readOnly ?? false);
  const block = timescaleActionBlock(info, readOnly, true);

  // from the newest materialized bucket on; a cagg that never materialized starts at the beginning
  const watermark = detail?.watermarkState === "ok" && detail.watermark ? detail.watermark : "";
  const [start, setStart] = useState(watermark);
  const [end, setEnd] = useState("");
  const [running, setRunning] = useState(false);

  // the statement shown is the one that runs: both come from the debounced text
  const debStart = useDebounced(start.trim(), 300);
  const debEnd = useDebounced(end.trim(), 300);
  const settled = debStart === start.trim() && debEnd === end.trim();

  const [sql, setSql] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    timescaleApi
      .actionSql(target.sessionId, target.database, { kind: "refreshCagg", schema, name, start: debStart || null, end: debEnd || null })
      .then(
        (text) => {
          if (stale) return;
          setSql(text);
          setError(null);
        },
        (e) => {
          if (stale) return;
          setSql(null);
          setError(String(e));
        },
      );
    return () => {
      stale = true;
    };
  }, [target.sessionId, target.database, schema, name, debStart, debEnd]);

  const buckets = summary.bucketWidth ? estimateBuckets(debStart, debEnd, summary.bucketWidth) : null;
  const endOffset = detail?.policy?.config?.end_offset;
  const offset = endOffset == null ? null : shortInterval(String(endOffset));

  async function refresh() {
    setRunning(true);
    const ok = await runTimescaleAction(target, { kind: "refreshCagg", schema, name, start: debStart || null, end: debEnd || null }, {
      label: `Refresh ${schema}.${name}`,
    });
    setRunning(false);
    if (ok) {
      onDone();
      onClose();
    }
  }

  return (
    <Modal
      title={`Refresh ${schema}.${name}`}
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!!block || !settled || !sql || running}
            title={block ?? undefined}
            onClick={refresh}
          >
            <RefreshCw />
            Refresh
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-1.5">
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              size="sm"
              onClick={() => {
                const r = rangeForDays(p.days, new Date());
                setStart(r.start);
                setEnd(r.end);
              }}
            >
              {p.label}
            </Button>
          ))}
        </div>

        <div className="flex items-start gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-fg-2">Start</span>
            <Input
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder="from the beginning"
              spellCheck={false}
              className="font-data"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-fg-2">End</span>
            <Input
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              placeholder="up to now"
              spellCheck={false}
              className="font-data"
            />
            {offset && (
              <span className="text-sm text-fg-3">
                The refresh policy stops {offset} before now; buckets newer than that are still filling up.
              </span>
            )}
          </label>
        </div>

        <div className="rounded-md border border-line-soft bg-panel px-3 py-2">
          {sql ? (
            <SqlText text={sql} className="whitespace-pre-wrap" />
          ) : error ? (
            <span className="text-sm text-danger">{error}</span>
          ) : (
            <span className="text-sm text-fg-3">Reading the statement…</span>
          )}
        </div>

        {buckets !== null && summary.bucketWidth && (
          <span className="text-sm text-fg-2">
            About {formatInt(buckets)} {buckets === 1 ? "bucket" : "buckets"} of {shortInterval(summary.bucketWidth)}
          </span>
        )}
        <span className="text-sm text-fg-3">
          Runs on a connection of its own, outside any transaction (TimescaleDB refuses it inside one). Large ranges can take a while.
        </span>
        {block && <span className="text-sm text-fg-3">{block}</span>}
      </div>
    </Modal>
  );
}
