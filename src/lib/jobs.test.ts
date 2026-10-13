import { describe, expect, it } from "vitest";
import type { JobInfo } from "../types/timescale";
import { clockMs, errorsHidden, filterJobs, relativeTime, sortJobs, timeOf } from "./jobs";

function job(jobId: number, extra: Partial<JobInfo> = {}): JobInfo {
  return {
    jobId,
    applicationName: `job ${jobId}`,
    procSchema: "_timescaledb_functions",
    procName: "policy_refresh_continuous_aggregate",
    kind: "refresh",
    targetSchema: "public",
    targetName: "metrics_hourly",
    scheduleInterval: "01:00:00",
    scheduled: true,
    config: null,
    owner: "postgres",
    lastRunStatus: "Success",
    jobStatus: "Scheduled",
    lastRunStartedAt: "2026-10-13 02:00:00+00",
    lastSuccessfulFinish: "2026-10-13 02:00:01+00",
    lastRunDuration: "00:00:01.5",
    nextStart: "2026-10-13 03:00:00+00",
    totalRuns: 10,
    totalFailures: 0,
    lastError: null,
    lastErrorAt: null,
    ...extra,
  };
}

describe("filterJobs", () => {
  const jobs = [
    job(1),
    job(2, { lastRunStatus: "Failed", lastError: "boom" }),
    job(3, { kind: "internal", applicationName: "Telemetry Reporter" }),
    job(4, { kind: "retention", lastRunStatus: "Failed", lastError: null }),
  ];

  it("keeps everything when no filter is on", () => {
    expect(filterJobs(jobs, { failedOnly: false, hideInternal: false }).map((j) => j.jobId)).toEqual([2, 4, 1, 3]);
  });

  it("keeps only the failed jobs", () => {
    expect(filterJobs(jobs, { failedOnly: true, hideInternal: false }).map((j) => j.jobId)).toEqual([2, 4]);
  });

  it("leaves out the internal jobs", () => {
    expect(filterJobs(jobs, { failedOnly: false, hideInternal: true }).map((j) => j.jobId)).not.toContain(3);
  });

  it("applies both filters", () => {
    expect(filterJobs(jobs, { failedOnly: true, hideInternal: true }).map((j) => j.jobId)).toEqual([2, 4]);
  });
});

describe("sortJobs", () => {
  it("puts failed jobs first, then the ones due soonest", () => {
    const sorted = sortJobs([
      job(1, { nextStart: "2026-10-13 05:00:00+00" }),
      job(2, { nextStart: "2026-10-13 04:00:00+00" }),
      job(3, { lastRunStatus: "Failed", nextStart: "2026-10-13 09:00:00+00" }),
    ]);
    expect(sorted.map((j) => j.jobId)).toEqual([3, 2, 1]);
  });

  it("puts jobs with no next run last, then by id", () => {
    const sorted = sortJobs([
      job(5, { nextStart: "infinity" }),
      job(4, { nextStart: null }),
      job(2, { nextStart: "2026-10-13 04:00:00+00" }),
      job(1, { nextStart: "infinity" }),
    ]);
    expect(sorted.map((j) => j.jobId)).toEqual([2, 1, 4, 5]);
  });

  it("does not change the list it was given", () => {
    const input = [job(2), job(1)];
    sortJobs(input);
    expect(input.map((j) => j.jobId)).toEqual([2, 1]);
  });
});

describe("errorsHidden", () => {
  it("is true when every failed job has no error text", () => {
    expect(errorsHidden([job(1), job(2, { lastRunStatus: "Failed", lastError: null })])).toBe(true);
  });

  it("is false when a failed job shows its error", () => {
    expect(errorsHidden([job(1, { lastRunStatus: "Failed", lastError: "boom" }), job(2, { lastRunStatus: "Failed" })])).toBe(false);
  });

  it("is false when nothing failed", () => {
    expect(errorsHidden([job(1)])).toBe(false);
  });
});

describe("timeOf", () => {
  it("reads the server's text form, with microseconds and a short offset", () => {
    expect(timeOf("2026-10-13 03:23:09.773473+00")).toBe(Date.parse("2026-10-13T03:23:09.773Z"));
  });

  it("reads an offset that isn't UTC", () => {
    expect(timeOf("2026-10-13 03:00:00+02")).toBe(Date.parse("2026-10-13T01:00:00Z"));
  });

  it("returns null for infinity, null and junk", () => {
    expect(timeOf("infinity")).toBeNull();
    expect(timeOf("-infinity")).toBeNull();
    expect(timeOf(null)).toBeNull();
    expect(timeOf("soon")).toBeNull();
  });
});

describe("clockMs", () => {
  it("reads the clock form of an interval", () => {
    expect(clockMs("00:00:00.460925")).toBe(461);
    expect(clockMs("01:02:03")).toBe(3_723_000);
  });

  it("reads a day count in front of the clock", () => {
    expect(clockMs("1 day 02:00:00")).toBe(93_600_000);
  });

  it("returns null for anything else", () => {
    expect(clockMs(null)).toBeNull();
    expect(clockMs("1 hour")).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-13T03:00:00Z");

  it("says how long ago a past time was", () => {
    expect(relativeTime("2026-10-13 02:00:00+00", now)).toBe("1h 00m ago");
  });

  it("says how far off a future time is", () => {
    expect(relativeTime("2026-10-13 03:05:00+00", now)).toBe("in 5m 00s");
  });

  it("says just now within a second", () => {
    expect(relativeTime("2026-10-13 03:00:00.400+00", now)).toBe("just now");
  });

  it("is empty when the time is unknown", () => {
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("infinity", now)).toBe("");
  });
});
