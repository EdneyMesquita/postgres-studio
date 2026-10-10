import { describe, expect, it } from "vitest";
import type { AvailableExtension } from "../types/objects";
import { extensionState, filterExtensions } from "./extensions";

const ext = (name: string, installedVersion: string | null, defaultVersion: string | null, comment: string | null = null): AvailableExtension => ({
  name,
  installedVersion,
  defaultVersion,
  comment,
  schema: installedVersion ? "public" : null,
});

describe("extensionState", () => {
  it("tells available, installed and updatable apart", () => {
    expect(extensionState(ext("a", null, "1.0"))).toBe("available");
    expect(extensionState(ext("a", "1.0", "1.0"))).toBe("installed");
    expect(extensionState(ext("a", "1.0", "1.1"))).toBe("update");
    expect(extensionState(ext("a", "1.0", null))).toBe("installed");
  });
});

describe("filterExtensions", () => {
  const list = [ext("pg_trgm", "1.6", "1.6", "text similarity measurement"), ext("citext", null, "1.6", "case-insensitive strings"), ext("hstore", "1.7", "1.8")];
  it("searches names and descriptions, ignoring case", () => {
    expect(filterExtensions(list, "TRG", "all").map((e) => e.name)).toEqual(["pg_trgm"]);
    expect(filterExtensions(list, "case-insens", "all").map((e) => e.name)).toEqual(["citext"]);
  });
  it("filters by state and sorts by name", () => {
    expect(filterExtensions(list, "", "all").map((e) => e.name)).toEqual(["citext", "hstore", "pg_trgm"]);
    expect(filterExtensions(list, "", "installed").map((e) => e.name)).toEqual(["hstore", "pg_trgm"]);
    expect(filterExtensions(list, "", "update").map((e) => e.name)).toEqual(["hstore"]);
  });
});
