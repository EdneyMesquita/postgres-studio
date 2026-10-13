import { useState } from "react";
import { axisTicks, chunkBars, compactRange } from "@/lib/chunkChart";
import type { ChartChunk } from "@/lib/chunkChart";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

const HEIGHT = 140;
const VIEW_W = 1000;

/** Each chunk's size over time, oldest left; a columnstore chunk is its size before (faint) behind its size now. */
export function ChunkSizeChart({ chunks }: { chunks: ChartChunk[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (chunks.length < 2) return null;

  const { bars, maxBytes } = chunkBars(chunks);
  const ticks = axisTicks(bars);
  const active = hover !== null ? bars[hover] : null;
  const anyColumnstore = bars.some((b) => b.columnstoreCount > 0);

  return (
    <div className="border-b border-line-soft px-3.5 pt-2 pb-1.5">
      <div className="mb-1 flex items-center gap-3 text-xs text-fg-3">
        <span className="font-data">max {formatBytes(maxBytes)}</span>
        <span className="flex-1" />
        {anyColumnstore && (
          <span className="inline-flex items-center gap-1.5">
            <i className="inline-block size-2.5 rounded-xs bg-accent/30" />
            Before columnstore
          </span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-xs bg-accent" />
          Now
        </span>
      </div>
      <div className="relative" style={{ height: HEIGHT }} onMouseLeave={() => setHover(null)}>
        <svg
          viewBox={`0 0 ${VIEW_W} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          role="img"
          aria-label="Chunk sizes over time"
        >
          <line x1={0} x2={VIEW_W} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {bars.map((b, i) => (
            <g key={i} className={cn(hover !== null && hover !== i && "opacity-60")}>
              <rect
                x={b.x * VIEW_W}
                width={b.width * VIEW_W}
                y={HEIGHT - b.fullH * (HEIGHT - 2)}
                height={b.fullH * (HEIGHT - 2)}
                className={b.columnstoreCount > 0 ? "fill-accent/30" : "fill-accent"}
              />
              {b.columnstoreCount > 0 && (
                <rect
                  x={b.x * VIEW_W}
                  width={b.width * VIEW_W}
                  y={HEIGHT - b.solidH * (HEIGHT - 2)}
                  height={b.solidH * (HEIGHT - 2)}
                  className="fill-accent"
                />
              )}
              {/* the whole slot answers the pointer, so thin bars are easy to hit */}
              <rect
                x={(b.x - (1 / bars.length - b.width) / 2) * VIEW_W}
                width={(1 / bars.length) * VIEW_W}
                y={0}
                height={HEIGHT}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            </g>
          ))}
        </svg>
        {active && (
          <div
            className="pointer-events-none absolute top-0 z-[4] w-max max-w-[320px] rounded-md border border-line bg-panel px-2 py-1 text-xs text-fg-2 shadow-overlay"
            style={{
              left: `${(active.x + active.width / 2) * 100}%`,
              transform: `translateX(${active.x + active.width / 2 > 0.5 ? "calc(-100% - 8px)" : "8px"})`,
            }}
          >
            <div className="font-data text-fg">{active.count > 1 ? `${active.first} … ${active.last}` : active.first}</div>
            <div className="font-data text-fg-3">{compactRange(active.rangeStart, active.rangeEnd)}</div>
            <div className="tabular-nums">
              {active.columnstoreCount > 0 ? `${formatBytes(active.fullBytes)} → ${formatBytes(active.solidBytes)}` : formatBytes(active.solidBytes)}
              {active.count > 1 && <span className="text-fg-3"> · {active.count} chunks</span>}
            </div>
          </div>
        )}
      </div>
      <div className="relative mt-1 h-4 text-xs text-fg-3">
        {ticks.map((t) => (
          <span
            key={t.index}
            className="font-data absolute whitespace-nowrap"
            style={{
              left: `${t.x * 100}%`,
              transform: t.align === "start" ? "translateX(0)" : t.align === "end" ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
