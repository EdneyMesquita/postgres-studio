import { describe, expect, it } from "vitest";
import { estimateBuckets, intervalMs, parseBound, rangeForDays, utcTimestamp } from "./refreshRange";

const SEP_1 = Date.UTC(2026, 8, 1);

describe("intervalMs", () => {
  it("reads the interval forms PostgreSQL writes for a bucket width", () => {
    expect(intervalMs("01:00:00")).toBe(3_600_000);
    expect(intervalMs("00:05:00")).toBe(300_000);
    expect(intervalMs("1 hour")).toBe(3_600_000);
    expect(intervalMs("1 day")).toBe(86_400_000);
    expect(intervalMs("7 days")).toBe(7 * 86_400_000);
    expect(intervalMs("1 day 02:00:00")).toBe(26 * 3_600_000);
    expect(intervalMs("15 minutes")).toBe(900_000);
    expect(intervalMs("1 week")).toBe(7 * 86_400_000);
  });

  it("gives up on months, years and anything it doesn't know", () => {
    expect(intervalMs("1 mon")).toBeNull();
    expect(intervalMs("1 month")).toBeNull();
    expect(intervalMs("1 year")).toBeNull();
    expect(intervalMs("3 fortnights")).toBeNull();
    expect(intervalMs("soon")).toBeNull();
    expect(intervalMs("")).toBeNull();
  });
});

describe("parseBound", () => {
  it("reads a date and a date with a time and offset", () => {
    expect(parseBound("2026-09-01")).toBe(SEP_1);
    expect(parseBound("2026-09-01 00:00+00")).toBe(SEP_1);
    expect(parseBound("2026-09-01 02:00+02")).toBe(SEP_1);
    expect(parseBound("2026-09-01 02:00:00+0200")).toBe(SEP_1);
    expect(parseBound("2026-09-01T00:00:00Z")).toBe(SEP_1);
    expect(parseBound("2026-09-01 00:00:30.5+00")).toBe(SEP_1 + 30_500);
  });

  it("takes a time without an offset as UTC", () => {
    expect(parseBound("2026-09-01 10:00")).toBe(SEP_1 + 10 * 3_600_000);
  });

  it("returns null for empty and unparseable text", () => {
    expect(parseBound("")).toBeNull();
    expect(parseBound("   ")).toBeNull();
    expect(parseBound("yesterday")).toBeNull();
    expect(parseBound("2026-09-01+02")).toBeNull();
    expect(parseBound("2026-13-45")).toBeNull();
  });
});

describe("estimateBuckets", () => {
  it("counts the buckets in a date range for each width", () => {
    expect(estimateBuckets("2026-09-01", "2026-09-02", "1 hour")).toBe(24);
    expect(estimateBuckets("2026-09-01", "2026-09-02", "01:00:00")).toBe(24);
    expect(estimateBuckets("2026-09-01", "2026-09-08", "1 day")).toBe(7);
  });

  it("rounds a partial bucket up", () => {
    expect(estimateBuckets("2026-09-01 00:00+00", "2026-09-01 02:30+00", "1 hour")).toBe(3);
  });

  it("gives no estimate for an open start, an unknown width or an empty range; an open end counts up to now", () => {
    expect(estimateBuckets("", "2026-09-02", "1 hour")).toBeNull();
    expect(estimateBuckets("2026-09-01", "", "1 hour", Date.parse("2026-09-02T00:00:00Z"))).toBe(24);
    expect(estimateBuckets("2026-09-01", "2026-09-02", null)).toBeNull();
    expect(estimateBuckets("2026-09-01", "2026-09-02", "1 mon")).toBeNull();
    expect(estimateBuckets("2026-09-02", "2026-09-01", "1 hour")).toBeNull();
    expect(estimateBuckets("2026-09-01", "2026-09-01", "1 hour")).toBeNull();
    expect(estimateBuckets("nope", "2026-09-02", "1 hour")).toBeNull();
  });
});

describe("rangeForDays", () => {
  it("starts that many days back, from a UTC timestamp literal, and leaves the end open", () => {
    const now = new Date("2026-10-12T15:30:00Z");
    expect(rangeForDays(7, now)).toEqual({ start: "2026-10-05 15:30:00+00", end: "" });
    expect(rangeForDays(30, now)).toEqual({ start: "2026-09-12 15:30:00+00", end: "" });
  });

  it("leaves both bounds open for everything", () => {
    expect(rangeForDays(null, new Date())).toEqual({ start: "", end: "" });
  });

  it("writes timestamps that parse back to the same instant", () => {
    const now = new Date("2026-10-12T15:30:00Z");
    expect(parseBound(utcTimestamp(now))).toBe(now.getTime());
  });
});
