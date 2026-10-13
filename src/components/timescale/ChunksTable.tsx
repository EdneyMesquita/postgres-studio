import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { useState } from "react";
import { ActionMenuButton } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { Button } from "@/components/ui/button";
import { compactRange } from "@/lib/chunkChart";
import { formatBytes } from "@/lib/format";
import { compressionRatio, formatRatio } from "@/lib/timescale";
import { cn } from "@/lib/utils";
import type { ChunkInfo } from "../../types/timescale";
import { td, th } from "../table/structureParts";
import { runTimescaleAction } from "./runAction";
import type { TimescaleDetail } from "./useTimescaleDetail";

const FIRST = 50;

/** The chunks, newest first, with a convert action on each when the hypertable has a columnstore. */
export function ChunksTable({ chunks, ts, canConvert }: { chunks: ChunkInfo[]; ts: TimescaleDetail; canConvert: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? chunks : chunks.slice(0, FIRST);

  async function convert(c: ChunkInfo) {
    if (!ts.target) return;
    const name = `${c.schema}.${c.name}`;
    const toRowstore = c.isCompressed;
    const ok = await runTimescaleAction(
      ts.target,
      { kind: toRowstore ? "toRowstore" : "toColumnstore", schema: c.schema, name: c.name },
      {
        label: `${toRowstore ? "Convert to rowstore" : "Convert to columnstore"}: ${c.name}`,
        ask: toRowstore
          ? {
              title: "Convert the chunk to rowstore?",
              detail: `${name} is decompressed${c.beforeBytes !== null ? `; it will take about ${formatBytes(c.beforeBytes)} again` : ""}. Queries on it get slower and writes to it faster.`,
              confirmLabel: "Convert to rowstore",
            }
          : {
              title: "Convert the chunk to columnstore?",
              detail: `${name} is compressed in place. Writes to a columnstore chunk are slower until it is converted back.`,
              confirmLabel: "Convert to columnstore",
            },
      },
    );
    if (ok) ts.done();
  }

  function entries(c: ChunkInfo): MenuEntry[] {
    const reason = ts.block(true);
    return [
      { heading: c.name },
      ...(reason ? [{ heading: reason }] : []),
      c.isCompressed
        ? { label: "Convert to rowstore", icon: ArrowUpFromLine, disabled: !!reason, onSelect: () => void convert(c) }
        : { label: "Convert to columnstore", icon: ArrowDownToLine, disabled: !!reason, onSelect: () => void convert(c) },
    ];
  }

  return (
    <>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={th}>Chunk</th>
            <th className={th}>Range</th>
            <th className={th}>State</th>
            <th className={cn(th, "text-right")}>Size</th>
            <th className={th}>Before → after</th>
            {canConvert && <th className={cn(th, "w-9")} />}
          </tr>
        </thead>
        <tbody>
          {shown.map((c) => {
            const ratio = c.isCompressed ? compressionRatio(c.beforeBytes, c.afterBytes) : null;
            return (
              <tr key={`${c.schema}.${c.name}`} className="hover:bg-row-hover">
                <td className={cn(td, "font-data whitespace-nowrap")}>
                  <button
                    type="button"
                    className="text-accent-text hover:underline"
                    title={`Open ${c.schema}.${c.name}`}
                    onClick={() => ts.open(c.schema, c.name, "r")}
                  >
                    {c.name}
                  </button>
                </td>
                <td className={cn(td, "font-data whitespace-nowrap text-fg-2")}>{compactRange(c.rangeStart, c.rangeEnd)}</td>
                <td className={td}>
                  <span
                    className={cn(
                      "rounded-sm px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
                      c.isCompressed ? "bg-accent/12 text-accent-text" : "bg-fg/7 text-fg-2",
                    )}
                  >
                    {c.isCompressed ? "columnstore" : "rowstore"}
                  </span>
                </td>
                <td className={cn(td, "text-right tabular-nums")}>{c.totalBytes !== null ? formatBytes(c.totalBytes) : ""}</td>
                <td className={cn(td, "whitespace-nowrap text-fg-2 tabular-nums")}>
                  {c.isCompressed && c.beforeBytes !== null && c.afterBytes !== null ? (
                    <>
                      {formatBytes(c.beforeBytes)} → {formatBytes(c.afterBytes)}
                      {ratio !== null && <span className="ml-2 text-fg-3">{formatRatio(ratio)}</span>}
                    </>
                  ) : (
                    <span className="text-fg-3">—</span>
                  )}
                </td>
                {canConvert && (
                  <td className={cn(td, "text-right")}>
                    <ActionMenuButton entries={() => entries(c)} label={`Actions for chunk ${c.name}`} align="end" />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {chunks.length > FIRST && (
        <div className="border-b border-line-soft px-3.5 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)}>
            {all ? `Show the first ${FIRST}` : `Show all ${chunks.length}`}
          </Button>
        </div>
      )}
    </>
  );
}
