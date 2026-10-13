import { describe, expect, it } from "vitest";
import { TIMESCALE_FUNCTIONS, compressionRatio, formatRatio, shortInterval } from "./timescale";

describe("TIMESCALE_FUNCTIONS", () => {
  it("names each function once", () => {
    const names = TIMESCALE_FUNCTIONS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers the functions the app and the console use", () => {
    const names = new Set(TIMESCALE_FUNCTIONS.map((f) => f.name));
    for (const n of ["time_bucket", "locf", "show_chunks", "drop_chunks", "hypertable_size", "create_hypertable", "add_columnstore_policy", "refresh_continuous_aggregate", "alter_job", "timescaledb_post_restore"]) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("marks procedures with CALL and leaves functions without it", () => {
    const procs = ["add_columnstore_policy", "remove_columnstore_policy", "convert_to_columnstore", "convert_to_rowstore", "refresh_continuous_aggregate", "run_job"];
    for (const f of TIMESCALE_FUNCTIONS) {
      if (procs.includes(f.name)) expect(f.detail).toMatch(new RegExp(`^procedure · CALL ${f.name}\\(`));
      else expect(f.detail).not.toMatch(/CALL /);
    }
  });
});

describe("shortInterval", () => {
  it.each([
    ["01:00:00", "1 h"],
    ["00:30:00", "30 min"],
    ["1 day", "1 d"],
    ["7 days", "7 d"],
    ["12:00:00", "12 h"],
    ["1 day 02:01:00", "1 d 2 h"],
    ["00:00:30", "30 s"],
    ["1 mon", "1 mo"],
    ["2 mons", "2 mo"],
    ["1 year", "1 y"],
    ["02:01:13.5", "2 h 1 min"],
    ["1 hour", "1 h"],
    ["60 days", "60 d"],
  ])("reads %j as %j", (input, expected) => {
    expect(shortInterval(input)).toBe(expected);
  });

  it("keeps only the two most significant units", () => {
    expect(shortInterval("1 year 2 mons 3 days 04:05:06")).toBe("1 y 2 mo");
    expect(shortInterval("3 days 04:05:06")).toBe("3 d 4 h");
    expect(shortInterval("1 week 2 days")).toBe("1 w 2 d");
  });

  it("skips zero units", () => {
    expect(shortInterval("1 day 00:00:30")).toBe("1 d 30 s");
    expect(shortInterval("2 days 0 hours")).toBe("2 d");
  });

  it("reads a zero interval as zero seconds", () => {
    expect(shortInterval("00:00:00")).toBe("0 s");
    expect(shortInterval("0 days")).toBe("0 s");
  });

  it("reads an empty or missing interval as empty", () => {
    expect(shortInterval("")).toBe("");
    expect(shortInterval("   ")).toBe("");
    expect(shortInterval(null)).toBe("");
    expect(shortInterval(undefined)).toBe("");
  });

  it("returns input it does not understand as given", () => {
    expect(shortInterval("every now and then")).toBe("every now and then");
  });

  it("keeps the sign of a negative interval", () => {
    expect(shortInterval("-1 days")).toBe("-1 d");
    expect(shortInterval("-01:30:00")).toBe("-1 h -30 min");
  });
});

describe("compressionRatio", () => {
  it("divides the size before by the size after", () => {
    expect(compressionRatio(1000, 100)).toBe(10);
    expect(compressionRatio(62, 10)).toBeCloseTo(6.2);
  });

  it("is null when a size is unknown", () => {
    expect(compressionRatio(null, 100)).toBeNull();
    expect(compressionRatio(100, null)).toBeNull();
    expect(compressionRatio(null, null)).toBeNull();
  });

  it("is null when the size after is 0", () => {
    expect(compressionRatio(100, 0)).toBeNull();
  });

  it("is 0 when nothing was saved before", () => {
    expect(compressionRatio(0, 50)).toBe(0);
  });
});

describe("formatRatio", () => {
  it("prints one decimal and the times sign", () => {
    expect(formatRatio(6.2)).toBe("6.2×");
    expect(formatRatio(6.25)).toBe("6.3×");
    expect(formatRatio(10)).toBe("10.0×");
  });
});
