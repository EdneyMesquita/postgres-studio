import { describe, expect, it } from "vitest";
import { cellParts, kindClass, valueKind } from "./pgValue";

const col = (typeName: string, typeOid = 0) => ({ name: "c", typeName, typeOid });

describe("graph and vector kinds", () => {
  it("tells agtype and the vector types by name, bare or with a modifier", () => {
    expect(valueKind(col("agtype"))).toBe("agtype");
    expect(valueKind(col("vector"))).toBe("vector");
    expect(valueKind(col("vector(1536)"))).toBe("vector");
    expect(valueKind(col("halfvec(8)"))).toBe("vector");
    expect(valueKind(col("sparsevec(5)"))).toBe("vector");
    expect(valueKind(col("jsonb", 3802))).toBe("json");
    expect(kindClass("vector")).toBe("text-json-number");
  });

  it("builds a cell from the value and the type", () => {
    expect(cellParts("vector", "vector", "[1,2,3]")).toEqual({ text: "[1, 2, 3]", tag: "3d" });
    expect(cellParts("vector", "sparsevec(5)", "{1:1,3:2}/5")).toEqual({ text: "{1:1, 3:2}", tag: "2 nnz · 5d" });
    expect(cellParts("vector", "vector", "not a vector")).toEqual({ text: "not a vector", tag: null });
    expect(cellParts("agtype", "agtype", '{"id": 1, "label": "P", "properties": {"name": "Ann"}}::vertex')).toEqual({
      text: '(:P {name: "Ann"})',
      tag: null,
    });
    expect(cellParts("bool", "boolean", "t")).toEqual({ text: "true", tag: null });
    expect(cellParts("text", "text", "a\nb")).toEqual({ text: "a ↵ b", tag: null });
  });
});
