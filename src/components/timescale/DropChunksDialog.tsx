import { useEffect, useState } from "react";
import { Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { compactRange } from "@/lib/chunkChart";
import { Modal } from "@/components/ui/Modal";
import { formatBytes, formatInt } from "@/lib/format";
import { timescaleApi } from "@/lib/timescaleApi";
import { useConnectionsStore } from "../../store/connectionsStore";
import { timescaleActionBlock, useTimescaleInfo } from "../../store/timescaleInfo";
import type { DropChunksPreview } from "../../types/timescale";
import { SqlText } from "../console/SqlText";
import { useDebounced, type TimescaleTarget } from "./RefreshCaggDialog";
import { runTimescaleAction } from "./runAction";

const th = "h-7 border-b border-line px-2 text-left text-sm font-medium whitespace-nowrap text-fg-2";
const td = "h-7 border-b border-line-soft px-2 align-middle text-sm whitespace-nowrap";

/**
 * Drops the chunks of a hypertable older than an age. Lists what would go
 * and the statement, and asks for the table's name first: a drop is for good.
 */
export function DropChunksDialog({
  target,
  schema,
  name,
  onClose,
  onDone,
}: {
  target: TimescaleTarget;
  schema: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const info = useTimescaleInfo(target.connection.id, target.sessionId, target.database);
  const readOnly = useConnectionsStore((s) => s.sessions[target.connection.id]?.readOnly ?? false);
  // drop_chunks works on the Apache edition too, so no community check here
  const block = timescaleActionBlock(info, readOnly, false);

  const [olderThan, setOlderThan] = useState("90 days");
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);

  // the preview, the statement and the drop all use the debounced age
  const age = useDebounced(olderThan.trim(), 300);
  const settled = age === olderThan.trim();

  const [loaded, setLoaded] = useState<{ age: string; preview: DropChunksPreview; sql: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!age) return;
    let stale = false;
    Promise.all([
      timescaleApi.dropChunksPreview(target.sessionId, target.database, schema, name, age),
      timescaleApi.actionSql(target.sessionId, target.database, { kind: "dropChunks", schema, name, olderThan: age }),
    ]).then(
      ([preview, sql]) => {
        if (stale) return;
        setLoaded({ age, preview, sql });
        setError(null);
      },
      (e) => {
        if (stale) return;
        setLoaded(null);
        setError(String(e));
      },
    );
    return () => {
      stale = true;
    };
  }, [target.sessionId, target.database, schema, name, age]);

  const current = settled && loaded !== null && loaded.age === age ? loaded : null;
  const count = current?.preview.chunks.length ?? 0;
  const canDrop = !!current && count > 0 && typed === name && !block && !running;

  async function drop() {
    setRunning(true);
    const ok = await runTimescaleAction(target, { kind: "dropChunks", schema, name, olderThan: age }, {
      label: `Drop chunks of ${schema}.${name}`,
    });
    setRunning(false);
    if (ok) {
      onDone();
      onClose();
    }
  }

  return (
    <Modal
      title="Drop chunks older than…"
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!canDrop} title={block ?? undefined} onClick={drop}>
            <Trash2 />
            {count === 1 ? "Drop 1 chunk" : `Drop ${formatInt(count)} chunks`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-fg-2">
          Drops whole chunks of {schema}.{name} older than the age. The rows in them are gone for good.
        </p>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg-2">Older than</span>
          <Input value={olderThan} onChange={(e) => setOlderThan(e.target.value)} spellCheck={false} className="font-data" />
        </label>

        {!age ? (
          <span className="text-sm text-fg-3">Enter an age, like 90 days.</span>
        ) : error && settled ? (
          <span className="text-sm text-danger">{error}</span>
        ) : !current ? (
          <span className="text-sm text-fg-3">Looking for chunks…</span>
        ) : count === 0 ? (
          <span className="text-sm text-fg-3">No chunk is that old.</span>
        ) : (
          <>
            <div className="max-h-56 overflow-auto rounded-md border border-line-soft">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={th}>Chunk</th>
                    <th className={th}>Range</th>
                    <th className={th}>State</th>
                    <th className={`${th} text-right`}>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {current.preview.chunks.map((c) => (
                    <tr key={`${c.schema}.${c.name}`}>
                      <td className={`${td} font-data`} title={`${c.schema}.${c.name}`}>
                        {c.name}
                      </td>
                      <td className={`${td} font-data text-fg-2`}>
                        {compactRange(c.rangeStart, c.rangeEnd)}
                      </td>
                      <td className={`${td} text-fg-2`}>{c.isCompressed ? "columnstore" : "rowstore"}</td>
                      <td className={`${td} text-right tabular-nums`}>{c.totalBytes != null ? formatBytes(c.totalBytes) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <span className="text-sm text-fg-2">
              {formatInt(count)} {count === 1 ? "chunk" : "chunks"}, {formatBytes(current.preview.totalBytes)} freed
            </span>
          </>
        )}

        {current && current.preview.dependentCaggs.length > 0 && (
          <div className="flex items-start gap-3 text-sm text-warn">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="m-0">
              These continuous aggregates read from {schema}.{name}. What they already materialized stays, but refreshing that range
              later would empty it.{" "}
              <span className="font-data">{current.preview.dependentCaggs.map((c) => `${c.schema}.${c.name}`).join(", ")}</span>
            </p>
          </div>
        )}

        {current && (
          <div className="rounded-md border border-line-soft bg-panel px-3 py-2 max-h-40 overflow-auto">
            <SqlText text={current.sql} className="whitespace-pre-wrap" />
          </div>
        )}

        <label className="flex flex-col gap-1.5 text-sm text-fg-2">
          <span>
            Type <b className="font-data text-fg">{name}</b> to confirm
          </span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} className="font-data" />
        </label>
        {block && <span className="text-sm text-fg-3">{block}</span>}
      </div>
    </Modal>
  );
}
