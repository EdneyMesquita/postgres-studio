import { describe, expect, it } from "vitest";
import type { ActivityRow } from "../types/objects";
import { filterActivity, formatDuration, oneLine } from "./activity";

function row(pid: number, extra: Partial<ActivityRow> = {}): ActivityRow {
  return {
    pid,
    user: "postgres",
    database: "shop",
    application: "psql",
    clientAddr: null,
    state: "active",
    waitEventType: null,
    waitEvent: null,
    backendType: "client backend",
    xactStart: null,
    xactAgeMs: null,
    queryStart: null,
    queryAgeMs: 0,
    blockedBy: [],
    query: "select 1",
    own: false,
    ...extra,
  };
}

describe("filterActivity", () => {
  const rows = [
    row(1, { state: "idle", queryAgeMs: 90_000 }),
    row(2, { state: "active", queryAgeMs: 5 }),
    row(3, { state: "idle in transaction", queryAgeMs: 4000 }),
    row(4, { state: "active", queryAgeMs: 2000, database: "analytics" }),
    row(5, { state: null, backendType: "walwriter", database: null }),
  ];
  const all = { hideIdle: false, database: null, showBackground: false };

  it("leaves server processes out unless asked", () => {
    expect(filterActivity(rows, all).map((r) => r.pid)).not.toContain(5);
    expect(filterActivity(rows, { ...all, showBackground: true }).map((r) => r.pid)).toContain(5);
  });
  it("hides idle sessions but keeps the ones idle in a transaction", () => {
    const ids = filterActivity(rows, { ...all, hideIdle: true }).map((r) => r.pid);
    expect(ids).not.toContain(1);
    expect(ids).toContain(3);
  });
  it("narrows to a database", () => {
    expect(filterActivity(rows, { ...all, database: "analytics" }).map((r) => r.pid)).toEqual([4]);
  });
  it("lists the longest-running active sessions first, idle ones last", () => {
    expect(filterActivity(rows, all).map((r) => r.pid)).toEqual([4, 2, 3, 1]);
  });
});

describe("formatDuration", () => {
  it("reads at the scale of the value", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(12)).toBe("12 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(95_400)).toBe("1m 35s");
    expect(formatDuration(3 * 3_600_000 + 5 * 60_000)).toBe("3h 05m");
    expect(formatDuration(50 * 3_600_000)).toBe("2d 2h");
  });
});

describe("oneLine", () => {
  it("collapses whitespace and cuts", () => {
    expect(oneLine("select  1\n  from t", 80)).toBe("select 1 from t");
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
    expect(oneLine(null, 5)).toBe("");
  });
});
