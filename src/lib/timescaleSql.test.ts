import { describe, expect, it } from "vitest";
import {
  alterJobSql,
  columnstorePolicySql,
  createCaggSql,
  createHypertableSql,
  refreshPolicySql,
  removePolicySql,
  retentionPolicySql,
} from "./timescaleSql";

describe("createHypertableSql", () => {
  it("builds the call for a plain table", () => {
    expect(createHypertableSql("public", "metrics", "ts")).toBe(
      [
        "-- migrate_data moves the rows already in the table into chunks and locks the table while it does.",
        `SELECT create_hypertable('public.metrics', by_range('ts', INTERVAL '7 days'), migrate_data => true);`,
      ].join("\n"),
    );
  });

  it("takes the chunk interval", () => {
    expect(createHypertableSql("public", "metrics", "ts", "1 day")).toContain("INTERVAL '1 day'");
  });

  it("quotes the table name and passes the time column as a plain name", () => {
    const sql = createHypertableSql("Telemetry", "Sensor Readings", "Ts");
    expect(sql).toContain(`create_hypertable('"Telemetry"."Sensor Readings"', by_range('Ts',`);
  });

  it("escapes a quote in the table name and the column name", () => {
    const sql = createHypertableSql("Telemetry", "Sensor's", "it's");
    expect(sql).toContain(`create_hypertable('"Telemetry"."Sensor''s"', by_range('it''s',`);
  });

  it("uses a placeholder and says so when there is no time column", () => {
    const sql = createHypertableSql("public", "devices", null);
    expect(sql).toContain("-- Replace <time column> with the timestamp column that partitions the table.");
    expect(sql).toContain("by_range('<time column>', INTERVAL '7 days')");
  });
});

describe("retentionPolicySql", () => {
  it("defaults to 90 days", () => {
    expect(retentionPolicySql("public", "metrics")).toBe(
      "SELECT add_retention_policy('public.metrics', drop_after => INTERVAL '90 days');",
    );
  });

  it("quotes odd names", () => {
    expect(retentionPolicySql("Telemetry", "Sensor Readings", "30 days")).toBe(
      `SELECT add_retention_policy('"Telemetry"."Sensor Readings"', drop_after => INTERVAL '30 days');`,
    );
  });
});

describe("columnstorePolicySql", () => {
  it("turns the columnstore on before adding the policy when no columns are given", () => {
    expect(columnstorePolicySql("public", "metrics")).toBe(
      [
        "ALTER TABLE public.metrics SET (timescaledb.enable_columnstore = true);",
        "CALL add_columnstore_policy('public.metrics', after => INTERVAL '7 days');",
      ].join("\n"),
    );
  });

  it("adds segmentby and orderby to the ALTER, quoting the columns", () => {
    expect(columnstorePolicySql("Telemetry", "Sensor Readings", "1 day", ["Device ID", "region"], ["Ts DESC"])).toBe(
      [
        `ALTER TABLE "Telemetry"."Sensor Readings" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = '"Device ID", region', timescaledb.orderby = '"Ts" DESC');`,
        `CALL add_columnstore_policy('"Telemetry"."Sensor Readings"', after => INTERVAL '1 day');`,
      ].join("\n"),
    );
  });

  it("keeps the direction of an orderby column and uppercases it", () => {
    const sql = columnstorePolicySql("public", "metrics", "7 days", [], ["ts asc nulls last", "Id"]);
    expect(sql).toContain(`timescaledb.orderby = 'ts ASC NULLS LAST, "Id"'`);
    expect(sql).not.toContain("segmentby");
  });

  it("escapes a quote in a column name", () => {
    const sql = columnstorePolicySql("public", "metrics", "7 days", ["it's"]);
    expect(sql).toContain(`timescaledb.segmentby = '"it''s"'`);
  });
});

describe("refreshPolicySql", () => {
  it("uses the defaults", () => {
    expect(refreshPolicySql("public", "metrics_hourly")).toBe(
      [
        "SELECT add_continuous_aggregate_policy('public.metrics_hourly',",
        "  start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');",
      ].join("\n"),
    );
  });

  it("takes the offsets and schedule", () => {
    const sql = refreshPolicySql("Telemetry", "Sensor Readings", "2 days", "30 min", "15 min");
    expect(sql).toContain(`add_continuous_aggregate_policy('"Telemetry"."Sensor Readings"',`);
    expect(sql).toContain("start_offset => INTERVAL '2 days', end_offset => INTERVAL '30 min', schedule_interval => INTERVAL '15 min'");
  });
});

describe("removePolicySql", () => {
  it("removes each kind with if_exists", () => {
    expect(removePolicySql("retention", "public", "metrics")).toBe("SELECT remove_retention_policy('public.metrics', if_exists => true);");
    expect(removePolicySql("columnstore", "public", "metrics")).toBe("CALL remove_columnstore_policy('public.metrics', if_exists => true);");
    expect(removePolicySql("refresh", "public", "metrics_hourly")).toBe(
      "SELECT remove_continuous_aggregate_policy('public.metrics_hourly', if_exists => true);",
    );
  });

  it("quotes odd names", () => {
    expect(removePolicySql("refresh", "Telemetry", "Sensor's view")).toBe(
      `SELECT remove_continuous_aggregate_policy('"Telemetry"."Sensor''s view"', if_exists => true);`,
    );
  });
});

describe("alterJobSql", () => {
  it("sets the schedule", () => {
    expect(alterJobSql(1000, { scheduleInterval: "2 hours" })).toBe("SELECT alter_job(1000, schedule_interval => INTERVAL '2 hours');");
  });

  it("sets the config as jsonb", () => {
    expect(alterJobSql(1000, { config: { compress_after: "7 days" } })).toBe(
      `SELECT alter_job(1000, config => '{"compress_after":"7 days"}'::jsonb);`,
    );
  });

  it("escapes quotes in the config", () => {
    expect(alterJobSql(3, { config: { note: "it's" } })).toBe(`SELECT alter_job(3, config => '{"note":"it''s"}'::jsonb);`);
  });

  it("sets both at once", () => {
    expect(alterJobSql(7, { scheduleInterval: "1 hour", config: { a: 1 } })).toBe(
      `SELECT alter_job(7, schedule_interval => INTERVAL '1 hour', config => '{"a":1}'::jsonb);`,
    );
  });

  it("changes nothing when nothing is given", () => {
    expect(alterJobSql(1000, {})).toBe("SELECT alter_job(1000);");
  });

  it("refuses a job id that is not an integer", () => {
    expect(() => alterJobSql(1.5, {})).toThrow();
    expect(() => alterJobSql(Number.NaN, {})).toThrow();
  });
});

describe("createCaggSql", () => {
  it("names the view by the bucket width", () => {
    expect(createCaggSql("public", "metrics", "ts", "1 hour")).toContain("CREATE MATERIALIZED VIEW public.metrics_hourly WITH");
    expect(createCaggSql("public", "metrics", "ts", "1 day")).toContain("CREATE MATERIALIZED VIEW public.metrics_daily WITH");
    expect(createCaggSql("public", "metrics", "ts", "15 min")).toContain("CREATE MATERIALIZED VIEW public.metrics_agg WITH");
  });

  it("builds the view on the quoted table and column", () => {
    const sql = createCaggSql("Telemetry", "Sensor Readings", "Ts", "1 hour");
    expect(sql).toBe(
      [
        "-- A starting point: change the select list, then refresh it with the policy below.",
        `CREATE MATERIALIZED VIEW "Telemetry"."Sensor Readings_hourly" WITH (timescaledb.continuous) AS`,
        `SELECT time_bucket(INTERVAL '1 hour', "Ts") AS bucket, count(*)`,
        `FROM "Telemetry"."Sensor Readings"`,
        "GROUP BY 1",
        "WITH NO DATA;",
        "-- SELECT add_continuous_aggregate_policy('\"Telemetry\".\"Sensor Readings_hourly\"',",
        "--   start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');",
      ].join("\n"),
    );
  });

  it("comments out the refresh policy", () => {
    const lines = createCaggSql("public", "metrics", "ts").split("\n");
    const policy = lines.slice(lines.findIndex((l) => l.includes("add_continuous_aggregate_policy")));
    for (const line of policy) expect(line.startsWith("-- ")).toBe(true);
  });

  it("uses a placeholder and says so when there is no time column", () => {
    const sql = createCaggSql("public", "devices", null);
    expect(sql).toContain("-- Replace <time column> with the table's timestamp column.");
    expect(sql).toContain("time_bucket(INTERVAL '1 hour', <time column>)");
  });
});
