import { describe, expect, it } from "vitest";
import { childrenOf, flatten, nodeLabel, type PlanNode, type Row } from "./explainPlan";
import chunkAppend from "./fixtures/timescale-chunk-append.json";
import constraintAware from "./fixtures/timescale-constraint-aware.json";
import orderedAppend from "./fixtures/timescale-ordered-append.json";
import columnar from "./fixtures/timescale-columnar.json";

/** The top node of a captured EXPLAIN (FORMAT JSON) document. */
function planOf(doc: unknown): PlanNode {
  return (doc as { Plan: PlanNode }[])[0].Plan;
}

function walk(plan: PlanNode): Row[] {
  const out: Row[] = [];
  flatten(plan, 0, out);
  return out;
}

// A plain Hash Join over two scans, the shape every planner version has printed for years.
const hashJoin: PlanNode = {
  "Node Type": "Hash Join",
  "Join Type": "Inner",
  "Hash Cond": "(o.customer_id = c.id)",
  "Actual Loops": 1,
  "Actual Rows": 5,
  "Plan Rows": 5,
  "Actual Total Time": 10,
  Plans: [
    {
      "Node Type": "Seq Scan",
      "Parent Relationship": "Outer",
      "Relation Name": "orders",
      Alias: "o",
      Filter: "(total > 10)",
      "Rows Removed by Filter": 50,
      "Actual Loops": 1,
      "Actual Rows": 100,
      "Plan Rows": 100,
      "Actual Total Time": 6,
    },
    {
      "Node Type": "Hash",
      "Parent Relationship": "Inner",
      "Actual Loops": 1,
      "Actual Rows": 10,
      "Plan Rows": 10,
      "Actual Total Time": 2,
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Parent Relationship": "Outer",
          "Relation Name": "customers",
          Alias: "c",
          "Sort Key": ["id", "name"],
          "Actual Loops": 1,
          "Actual Rows": 10,
          "Plan Rows": 10,
          "Actual Total Time": 1.5,
        },
      ],
    },
  ],
};

describe("flatten on a plain plan", () => {
  it("walks Plans depth-first with labels, depths and self times", () => {
    const rows = walk(hashJoin);
    expect(rows.map((r) => nodeLabel(r.node))).toEqual(["Inner Hash Join", "Seq Scan", "Hash", "Seq Scan"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 2]);
    expect(rows.map((r) => r.selfMs)).toEqual([2, 6, 0.5, 1.5]);
  });

  it("formats detail lines, arrays joined with commas", () => {
    const rows = walk(hashJoin);
    expect(rows[0].details).toEqual(["Hash Cond: (o.customer_id = c.id)"]);
    expect(rows[1].details).toEqual(["Filter: (total > 10)", "Rows Removed by Filter: 50"]);
    expect(rows[3].details).toEqual(["Sort Key: id, name"]);
  });
});

describe("nodeLabel", () => {
  it("names a Custom Scan by its provider", () => {
    const node: PlanNode = { "Node Type": "Custom Scan", "Custom Plan Provider": "ChunkAppend" };
    expect(nodeLabel(node)).toBe("ChunkAppend");
  });

  it("keeps Custom Scan when there is no provider", () => {
    expect(nodeLabel({ "Node Type": "Custom Scan" })).toBe("Custom Scan");
  });

  it("ignores a provider on a node that is not a custom scan", () => {
    expect(nodeLabel({ "Node Type": "Seq Scan", "Custom Plan Provider": "ChunkAppend" })).toBe("Seq Scan");
  });
});

describe("childrenOf", () => {
  it("returns Plans then the singular Plan", () => {
    const a: PlanNode = { "Node Type": "Seq Scan" };
    const b: PlanNode = { "Node Type": "Index Scan" };
    const c: PlanNode = { "Node Type": "Result" };
    expect(childrenOf({ "Node Type": "Append", Plans: [a, b], Plan: c })).toEqual([a, b, c]);
  });

  it("is empty for a leaf", () => {
    expect(childrenOf({ "Node Type": "Seq Scan" })).toEqual([]);
  });
});

describe("TimescaleDB detail keys", () => {
  it("shows them as detail lines, values formatted like the rest", () => {
    const rows = walk({
      "Node Type": "Custom Scan",
      "Custom Plan Provider": "ChunkAppend",
      Hypertable: "metrics",
      "Chunks excluded during startup": 0,
      "Chunks excluded during runtime": 27,
      "Runtime Exclusion": true,
      "Chunks Visited": 4,
      Order: "metrics.\"time\" DESC",
      "Vectorized Filter": "(cpu > 0.5)",
      "Bulk Decompression": false,
      "Grouping Policy": "partial",
      "Startup Exclusion": false,
    });
    expect(rows[0].details).toEqual([
      "Chunks excluded during startup: 0",
      "Chunks excluded during runtime: 27",
      "Runtime Exclusion: true",
      "Chunks Visited: 4",
      'Order: metrics."time" DESC',
      "Hypertable: metrics",
      "Vectorized Filter: (cpu > 0.5)",
      "Bulk Decompression: false",
      "Grouping Policy: partial",
      "Startup Exclusion: false",
    ]);
  });
});

// Real plans from TimescaleDB 2.30.2, captured with EXPLAIN (ANALYZE, FORMAT JSON).
describe("TimescaleDB plans", () => {
  it("labels a ChunkAppend scan by its provider, not Custom Scan", () => {
    const rows = walk(planOf(chunkAppend));
    expect(rows[0].node["Node Type"]).toBe("Custom Scan");
    expect(rows.map((r) => nodeLabel(r.node))).toEqual(["ChunkAppend", "Seq Scan", "Seq Scan", "Seq Scan"]);
    // now() is stable, so the 2-day cut is decided at startup and nothing is excluded at runtime.
    expect(rows[0].details).toEqual(["Chunks excluded during startup: 1", "Runtime Exclusion: false", "Startup Exclusion: true"]);
  });

  it("labels ConstraintAwareAppend and shows its Hypertable", () => {
    const rows = walk(planOf(constraintAware));
    expect(rows.map((r) => [nodeLabel(r.node), r.depth])).toEqual([
      ["ConstraintAwareAppend", 0],
      ["Append", 1],
      ["Seq Scan", 2],
      ["Seq Scan", 2],
      ["Seq Scan", 2],
    ]);
    expect(rows[0].details).toContain("Hypertable: metrics");
  });

  it("walks the singular Plan under DeferredChunkAppend", () => {
    const rows = walk(planOf(orderedAppend));
    expect(rows.map((r) => [nodeLabel(r.node), r.depth])).toEqual([
      ["Limit", 0],
      ["DeferredChunkAppend", 1],
      ["Limit", 2],
      ["Index Scan", 3],
    ]);
  });

  it("subtracts the singular Plan child's time from the parent's self time", () => {
    const rows = walk(planOf(orderedAppend));
    const deferred = planOf(orderedAppend).Plans![0];
    const child = deferred.Plan!;
    expect(rows[1].selfMs).toBeCloseTo(deferred["Actual Total Time"]! - child["Actual Total Time"]!, 6);
    expect(rows[1].selfMs).toBeLessThan(deferred["Actual Total Time"]!);
  });

  it("shows the visited-chunk and ordering details of DeferredChunkAppend", () => {
    const rows = walk(planOf(orderedAppend));
    expect(rows[1].details).toEqual(["Chunks Visited: 1", 'Order: "time" DESC']);
  });

  it("labels ColumnarScan and VectorAgg and shows their vectorized details", () => {
    const rows = walk(planOf(columnar));
    expect(rows.slice(0, 5).map((r) => [nodeLabel(r.node), r.depth])).toEqual([
      ["Aggregate", 0],
      ["ChunkAppend", 1],
      ["VectorAgg", 2],
      ["ColumnarScan", 3],
      ["Seq Scan", 4],
    ]);
    const columnarScan = rows.find((r) => nodeLabel(r.node) === "ColumnarScan")!;
    expect(columnarScan.details.some((d) => d.startsWith("Vectorized Filter: "))).toBe(true);
    expect(columnarScan.details.some((d) => d.startsWith("Bulk Decompression: "))).toBe(true);
    const vectorAgg = rows.find((r) => nodeLabel(r.node) === "VectorAgg")!;
    expect(vectorAgg.details.some((d) => d.startsWith("Grouping Policy: "))).toBe(true);
  });
});
