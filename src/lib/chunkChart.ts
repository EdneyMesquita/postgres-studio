/** Geometry for the chunk-size chart: pure, so the SVG component only draws. */

export interface ChartChunk {
  name: string;
  rangeStart: string | null;
  rangeEnd: string | null;
  isCompressed: boolean;
  totalBytes: number | null;
  beforeBytes: number | null;
  afterBytes: number | null;
}

export interface ChartBar {
  /** First and last chunk of the group, oldest first. */
  first: string;
  last: string;
  count: number;
  columnstoreCount: number;
  rangeStart: string | null;
  rangeEnd: string | null;
  /** Size before columnstore (the faint bar) and now (the solid one), in bytes. */
  fullBytes: number;
  solidBytes: number;
  /** Left edge and width, as fractions of the chart width. */
  x: number;
  width: number;
  /** Heights as fractions of the tallest bar. */
  fullH: number;
  solidH: number;
}

export interface ChartTick {
  index: number;
  /** Center of its bar, as a fraction of the chart width. */
  x: number;
  label: string;
  align: "start" | "middle" | "end";
}

export const MAX_BARS = 120;

function byStart(a: ChartChunk, b: ChartChunk): number {
  const x = a.rangeStart ?? "";
  const y = b.rangeStart ?? "";
  // integer-time hypertables have numeric ranges, which don't sort as text
  if (/^-?\d+$/.test(x) && /^-?\d+$/.test(y)) return Number(x) - Number(y);
  return x < y ? -1 : x > y ? 1 : 0;
}

function sizes(c: ChartChunk): { full: number; solid: number } {
  const total = c.totalBytes ?? 0;
  if (!c.isCompressed) return { full: total, solid: total };
  const solid = c.afterBytes ?? total;
  return { full: Math.max(c.beforeBytes ?? solid, solid), solid };
}

/** Bars oldest first; past `maxBars` chunks, adjacent ones are summed into one bar. */
export function chunkBars(chunks: ChartChunk[], maxBars = MAX_BARS, gap = 0.2): { bars: ChartBar[]; maxBytes: number } {
  const sorted = [...chunks].sort(byStart);
  const per = Math.max(1, Math.ceil(sorted.length / Math.max(1, maxBars)));
  const groups: ChartChunk[][] = [];
  for (let i = 0; i < sorted.length; i += per) groups.push(sorted.slice(i, i + per));

  const raw = groups.map((g) => {
    let full = 0;
    let solid = 0;
    for (const c of g) {
      const s = sizes(c);
      full += s.full;
      solid += s.solid;
    }
    return { g, full, solid };
  });
  const maxBytes = Math.max(0, ...raw.map((r) => r.full));
  const slot = raw.length ? 1 / raw.length : 1;
  const bars = raw.map(({ g, full, solid }, i): ChartBar => ({
    first: g[0].name,
    last: g[g.length - 1].name,
    count: g.length,
    columnstoreCount: g.filter((c) => c.isCompressed).length,
    rangeStart: g[0].rangeStart,
    rangeEnd: g[g.length - 1].rangeEnd,
    fullBytes: full,
    solidBytes: solid,
    x: i * slot + (slot * gap) / 2,
    width: slot * (1 - gap),
    fullH: maxBytes > 0 ? full / maxBytes : 0,
    solidH: maxBytes > 0 ? solid / maxBytes : 0,
  }));
  return { bars, maxBytes };
}

/** `2026-03-04T10:00:00+00:00` or `2026-03-04 10:00:00+00` as `2026-03-04` (with ` 10:00` when not midnight); anything else as is. */
export function compactDate(text: string | null, withTime = true): string {
  if (!text) return "—";
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d)/.exec(text);
  if (!m) return text;
  return withTime && m[2] !== "00:00" ? `${m[1]} ${m[2]}` : m[1];
}

/** A chunk's range as `start → end`. */
export function compactRange(start: string | null, end: string | null): string {
  return `${compactDate(start)} → ${compactDate(end)}`;
}

/** Up to `max` evenly spread date ticks under the bars; the outer ones align inward so they stay inside the chart. */
export function axisTicks(bars: ChartBar[], max = 5): ChartTick[] {
  if (bars.length === 0) return [];
  const count = Math.min(max, bars.length);
  const seen = new Set<number>();
  const ticks: ChartTick[] = [];
  for (let i = 0; i < count; i++) {
    const index = count === 1 ? 0 : Math.round((i * (bars.length - 1)) / (count - 1));
    if (seen.has(index)) continue;
    seen.add(index);
    const bar = bars[index];
    ticks.push({
      index,
      x: bar.x + bar.width / 2,
      label: compactDate(bar.rangeStart, false),
      align: index === 0 ? "start" : index === bars.length - 1 ? "end" : "middle",
    });
  }
  return ticks;
}
