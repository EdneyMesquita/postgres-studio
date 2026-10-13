import { describe, expect, it } from "vitest";
import { axisTicks, chunkBars, compactDate, compactRange } from "./chunkChart";
import type { ChartChunk } from "./chunkChart";

function chunk(day: number, over: Partial<ChartChunk> = {}): ChartChunk {
  const d = String(day).padStart(2, "0");
  return {
    name: `_hyper_1_${day}_chunk`,
    rangeStart: `2026-03-${d}T00:00:00+00:00`,
    rangeEnd: `2026-03-${d}T23:59:59+00:00`,
    isCompressed: false,
    totalBytes: 100,
    beforeBytes: null,
    afterBytes: null,
    ...over,
  };
}

describe("chunkBars", () => {
  it("orders oldest first whatever the input order", () => {
    const { bars } = chunkBars([chunk(3), chunk(1), chunk(2)]);
    expect(bars.map((b) => b.first)).toEqual(["_hyper_1_1_chunk", "_hyper_1_2_chunk", "_hyper_1_3_chunk"]);
    expect(bars[0].x).toBeLessThan(bars[2].x);
  });

  it("draws a columnstore chunk as before (faint) and after (solid)", () => {
    const { bars, maxBytes } = chunkBars([
      chunk(1, { isCompressed: true, totalBytes: 20, beforeBytes: 100, afterBytes: 20 }),
      chunk(2, { totalBytes: 50 }),
    ]);
    expect(maxBytes).toBe(100);
    expect(bars[0]).toMatchObject({ fullBytes: 100, solidBytes: 20, fullH: 1, solidH: 0.2, columnstoreCount: 1 });
    expect(bars[1]).toMatchObject({ fullBytes: 50, solidBytes: 50, fullH: 0.5, solidH: 0.5 });
  });

  it("never lets the solid bar exceed the faint one", () => {
    const { bars } = chunkBars([chunk(1, { isCompressed: true, totalBytes: 30, beforeBytes: 10, afterBytes: 30 })]);
    expect(bars[0].fullBytes).toBe(30);
  });

  it("sums adjacent chunks into at most maxBars bars", () => {
    const many = Array.from({ length: 1000 }, (_, i) => chunk(1, { name: `c${i}`, rangeStart: String(i), rangeEnd: String(i + 1) }));
    const { bars } = chunkBars(many, 120);
    expect(bars.length).toBeLessThanOrEqual(120);
    expect(bars.reduce((n, b) => n + b.count, 0)).toBe(1000);
    expect(bars.reduce((n, b) => n + b.fullBytes, 0)).toBe(100_000);
    expect(bars[0]).toMatchObject({ first: "c0", rangeStart: "0" });
    expect(bars[bars.length - 1].last).toBe("c999");
  });

  it("sorts integer ranges as numbers", () => {
    const { bars } = chunkBars([chunk(1, { name: "b", rangeStart: "100" }), chunk(1, { name: "a", rangeStart: "20" })]);
    expect(bars.map((b) => b.first)).toEqual(["a", "b"]);
  });

  it("keeps every bar inside the chart", () => {
    const { bars } = chunkBars([chunk(1), chunk(2), chunk(3)]);
    for (const b of bars) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1);
    }
  });

  it("copes with no sizes at all", () => {
    const { bars, maxBytes } = chunkBars([chunk(1, { totalBytes: null })]);
    expect(maxBytes).toBe(0);
    expect(bars[0].fullH).toBe(0);
  });
});

describe("axisTicks", () => {
  it("picks evenly spread bars and aligns the outer ones inward", () => {
    const { bars } = chunkBars(Array.from({ length: 9 }, (_, i) => chunk(i + 1)));
    const ticks = axisTicks(bars, 3);
    expect(ticks.map((t) => t.index)).toEqual([0, 4, 8]);
    expect(ticks.map((t) => t.align)).toEqual(["start", "middle", "end"]);
    expect(ticks[0].label).toBe("2026-03-01");
  });

  it("does not repeat a bar when there are few", () => {
    const { bars } = chunkBars([chunk(1), chunk(2)]);
    expect(axisTicks(bars, 5).map((t) => t.index)).toEqual([0, 1]);
    expect(axisTicks([], 5)).toEqual([]);
  });
});

describe("compactDate", () => {
  it("drops the zone and midnight", () => {
    expect(compactDate("2026-03-04T00:00:00+00:00")).toBe("2026-03-04");
    expect(compactDate("2026-03-04 10:30:00+00")).toBe("2026-03-04 10:30");
    expect(compactDate("2026-03-04 10:30:00+00", false)).toBe("2026-03-04");
    expect(compactDate("1700000000")).toBe("1700000000");
    expect(compactDate(null)).toBe("—");
  });

  it("writes a range", () => {
    expect(compactRange("2026-03-04T00:00:00Z", null)).toBe("2026-03-04 → —");
  });
});
