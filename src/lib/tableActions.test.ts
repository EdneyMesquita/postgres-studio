import { describe, expect, it } from "vitest";
import { generatableFor, maintenanceFor } from "./tableActions";

describe("maintenanceFor", () => {
  it("offers every action on a table, and TRUNCATE only there", () => {
    expect(maintenanceFor("r")).toEqual(["vacuumAnalyze", "analyze", "reindex", "truncate"]);
    expect(maintenanceFor("p")).toContain("truncate");
    expect(maintenanceFor("m")).not.toContain("truncate");
  });
  it("offers only ANALYZE on a foreign table and nothing on a view or a sequence", () => {
    expect(maintenanceFor("f")).toEqual(["analyze"]);
    expect(maintenanceFor("v")).toEqual([]);
    expect(maintenanceFor("S")).toEqual([]);
  });
});

describe("generatableFor", () => {
  it("writes statements only for what can take them", () => {
    expect(generatableFor("r")).toEqual(["select", "insert", "update", "delete", "ddl"]);
    expect(generatableFor("v")).toEqual(["select", "ddl"]);
    expect(generatableFor("S")).toEqual([]);
  });
});
