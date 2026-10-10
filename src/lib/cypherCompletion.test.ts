import { describe, expect, it } from "vitest";
import { cachedProperties, cypherCandidates } from "./cypherCompletion";
import type { GraphInfo } from "../types/pg";

const graph: GraphInfo = {
  name: "social",
  namespace: "social",
  labels: [
    { name: "Person", kind: "v", rowEstimate: 2 },
    { name: "Has Space", kind: "v", rowEstimate: null },
    { name: "KNOWS", kind: "e", rowEstimate: 1 },
  ],
};

describe("cypher candidates", () => {
  it("offers the graph's vertex labels after (n: and its edge labels after [e:", () => {
    expect(cypherCandidates({ kind: "vertexLabel" }, graph, []).map((c) => c.insertText)).toEqual(["Person", "`Has Space`"]);
    expect(cypherCandidates({ kind: "edgeLabel" }, graph, []).map((c) => c.label)).toEqual(["KNOWS"]);
  });

  it("offers no labels for a graph it doesn't know", () => {
    expect(cypherCandidates({ kind: "vertexLabel" }, null, [])).toEqual([]);
  });

  it("offers the sampled properties, backticked when needed", () => {
    const got = cypherCandidates({ kind: "property", label: "Person", edge: false }, graph, ["name", "full name"]);
    expect(got.map((c) => c.insertText)).toEqual(["name", "`full name`"]);
    expect(got[0].detail).toBe("Person property");
  });

  it("offers keywords, the two-word phrases and functions elsewhere", () => {
    const got = cypherCandidates({ kind: "general" }, graph, []);
    const labels = got.map((c) => c.label);
    for (const k of ["MATCH", "OPTIONAL MATCH", "ORDER BY", "DETACH DELETE", "REDUCE", "XOR", "count"]) expect(labels).toContain(k);
    expect(got.find((c) => c.label === "count")?.insertText).toBe("count(");
  });
});

describe("property cache", () => {
  it("asks once, and again after a failure", async () => {
    let calls = 0;
    const ok = () => Promise.resolve(["a"]).finally(() => calls++);
    expect(await cachedProperties("k1", ok)).toEqual(["a"]);
    expect(await cachedProperties("k1", ok)).toEqual(["a"]);
    expect(calls).toBe(1);

    let tries = 0;
    const flaky = () => (++tries === 1 ? Promise.reject(new Error("LOAD needs superuser")) : Promise.resolve(["b"]));
    expect(await cachedProperties("k2", flaky)).toEqual([]);
    expect(await cachedProperties("k2", flaky)).toEqual(["b"]);
  });
});
