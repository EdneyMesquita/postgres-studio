import { describe, expect, it } from "vitest";
import {
  baseType,
  denseDims,
  indexContextAt,
  opclassesFor,
  shortNumber,
  vectorBlock,
  vectorHint,
  vectorSummary,
  vectorType,
} from "./pgvector";

describe("vector types", () => {
  it("reads both spellings of the type name", () => {
    expect(vectorType("vector(1536)")).toEqual({ type: "vector", dims: 1536 });
    expect(vectorType("vector")).toEqual({ type: "vector", dims: null });
    expect(vectorType("halfvec(3)")).toEqual({ type: "halfvec", dims: 3 });
    expect(vectorType("sparsevec(5)")).toEqual({ type: "sparsevec", dims: 5 });
    expect(vectorType("vector[]")).toBeNull();
    expect(vectorType("text")).toBeNull();
  });

  it("counts dimensions without parsing", () => {
    expect(denseDims("[1,2,3]")).toBe(3);
    expect(denseDims("[7]")).toBe(1);
    expect(denseDims("[]")).toBe(0);
  });
});

describe("vector display", () => {
  it("shows the first components and the dimension count", () => {
    expect(vectorSummary("vector", "[0.12,-0.3,0.55,0.01,0.9,0.4]")).toEqual({
      head: "[0.12, -0.3, 0.55, 0.01, …]",
      tag: "6d",
      dims: 6,
    });
  });

  it("shows a short vector whole", () => {
    expect(vectorSummary("vector", "[1,2,3]")).toEqual({ head: "[1, 2, 3]", tag: "3d", dims: 3 });
    expect(vectorSummary("halfvec", "[0.5,0.25,1]")?.head).toBe("[0.5, 0.25, 1]");
  });

  it("rounds long components", () => {
    expect(shortNumber("0.123456789")).toBe("0.123");
    expect(shortNumber("-7")).toBe("-7");
    expect(shortNumber("1e-7")).toBe("1e-7");
    expect(shortNumber("NaN")).toBe("NaN");
  });

  it("reports nnz and dimensions for a sparse vector", () => {
    expect(vectorSummary("sparsevec", "{1:1,3:2}/5")).toEqual({ head: "{1:1, 3:2}", tag: "2 nnz · 5d", dims: 5 });
    expect(vectorSummary("sparsevec", "{}/10")?.tag).toBe("0 nnz · 10d");
    expect(vectorSummary("sparsevec", "{1:1,2:2,3:3,4:4,5:5}/9")?.head).toBe("{1:1, 2:2, 3:3, 4:4, …}");
  });

  it("does not claim text that isn't a vector", () => {
    expect(vectorSummary("vector", "oops")).toBeNull();
    expect(vectorSummary("sparsevec", "[1,2]")).toBeNull();
  });

  it("handles a 16000-dimension vector", () => {
    const text = `[${Array.from({ length: 16000 }, (_, i) => i / 7).join(",")}]`;
    expect(vectorSummary("vector", text)?.tag).toBe("16000d");
  });

  it("lays out the whole value for the inspector", () => {
    expect(vectorBlock("vector", "[1,2,3]")).toEqual({ text: "[1, 2, 3]", tag: "3d" });
    expect(vectorBlock("sparsevec", "{1:1,3:2}/5")).toEqual({ text: "{1:1, 3:2}/5", tag: "2 nnz · 5d" });
  });

  it("hints what an edit takes", () => {
    expect(vectorHint("vector(3)")).toBe("[3 numbers]");
    expect(vectorHint("sparsevec(5)")).toBe("{index:value,…}/5");
    expect(vectorHint("text")).toBeNull();
  });
});

describe("index operator classes", () => {
  it("knows where an opclass goes", () => {
    expect(indexContextAt("CREATE INDEX ON items USING hnsw (embedding ")).toEqual({
      method: "hnsw",
      table: "items",
      column: "embedding",
    });
    expect(indexContextAt("create index i on public.items using ivfflat (\"My Col\" vec")).toEqual({
      method: "ivfflat",
      table: "public.items",
      column: '"My Col"',
    });
    expect(indexContextAt("CREATE INDEX ON items USING hnsw (embedding")).toBeNull();
    expect(indexContextAt("SELECT 1 USING hnsw (a ")).toBeNull();
    expect(indexContextAt("CREATE INDEX ON items USING btree (a ")).toBeNull();
  });

  it("offers the opclasses of the column's type and only those the method supports", () => {
    const names = (m: "hnsw" | "ivfflat", t: string | null) => opclassesFor(m, t).map((o) => o.name);
    expect(names("hnsw", "vector(3)")).toEqual(["vector_l2_ops", "vector_ip_ops", "vector_cosine_ops", "vector_l1_ops"]);
    expect(names("ivfflat", "vector(3)")).toEqual(["vector_l2_ops", "vector_ip_ops", "vector_cosine_ops"]);
    expect(names("hnsw", "sparsevec(9)")).toHaveLength(4);
    expect(names("hnsw", "bit(64)")).toEqual(["bit_hamming_ops", "bit_jaccard_ops"]);
    // unknown column: everything the method does
    expect(names("hnsw", null)).toHaveLength(14);
    expect(names("ivfflat", null)).toHaveLength(8);
    expect(baseType("Vector(3)")).toBe("vector");
  });
});
