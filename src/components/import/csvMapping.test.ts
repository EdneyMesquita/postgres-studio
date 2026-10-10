import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "@/types/pg";
import { autoMap, duplicateTargets, loadableColumns, missingRequired } from "./csvMapping";

function column(name: string, patch: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    position: 1,
    typeName: "text",
    typeOid: 25,
    category: "S",
    nullable: true,
    default: null,
    identity: null,
    generated: null,
    comment: null,
    enumValues: null,
    ...patch,
  };
}

describe("autoMap", () => {
  const targets = ["id", "Name", "email", "qty"];

  it("matches headers by name, ignoring case", () => {
    expect(autoMap(["QTY", "id", "NAME", "email"], 4, targets)).toEqual(["qty", "id", "Name", "email"]);
  });

  it("falls back to position for headers it can't match", () => {
    expect(autoMap(["a", "name", "c", "d"], 4, targets)).toEqual(["id", "Name", "email", "qty"]);
  });

  it("does not use a table column twice", () => {
    // "email" is taken by name, so the first column can't take it by position
    expect(autoMap(["x", "id", "email"], 3, ["email", "id", "other"])).toEqual([null, "id", "email"]);
  });

  it("maps by position without a header, and skips what's left over", () => {
    expect(autoMap(null, 3, ["a", "b"])).toEqual(["a", "b", null]);
    expect(autoMap(null, 1, ["a", "b"])).toEqual(["a"]);
  });
});

describe("mapping checks", () => {
  it("finds table columns used twice", () => {
    expect([...duplicateTargets(["a", null, "b", "a"])]).toEqual(["a"]);
    expect(duplicateTargets(["a", "b"]).size).toBe(0);
  });

  it("leaves out columns that refuse values", () => {
    const columns = [column("id", { identity: "a" }), column("d", { identity: "d" }), column("g", { generated: "s" }), column("n")];
    expect(loadableColumns(columns).map((c) => c.name)).toEqual(["d", "n"]);
  });

  it("names the required columns left unmapped", () => {
    const columns = [
      column("id", { nullable: false }),
      column("name", { nullable: false }),
      column("created", { nullable: false, default: "now()" }),
      column("note"),
      column("serial", { nullable: false, identity: "d" }),
    ];
    expect(missingRequired(columns, ["id", null])).toEqual(["name"]);
  });
});
