import { describe, expect, it } from "vitest";
import type { Tab } from "../store/sessionsStore";
import { connectionGroupId, pruneGroups, stripGroups } from "./tabGroups";

function tab(id: string, connectionId: string): Tab {
  return {
    kind: "console",
    id,
    connection: { id: connectionId, name: connectionId.toUpperCase(), summary: "" },
    database: "db",
    number: 1,
  };
}

const tabs = [tab("1", "prod"), tab("2", "local"), tab("3", "prod"), tab("4", "staging")];
const ids = (groups: ReturnType<typeof stripGroups>) => groups.map((g) => `${g.id}:${g.tabs.map((t) => t.id).join(",")}`);

describe("stripGroups", () => {
  it("groups by connection in the order of each connection's first tab", () => {
    expect(ids(stripGroups(tabs, "connection", [], {}))).toEqual([
      "connection:prod:1,3",
      "connection:local:2",
      "connection:staging:4",
    ]);
  });

  it("puts manual groups first and leaves their tabs out of the connection groups", () => {
    const groups = [{ id: "g1", name: "Refunds" }];
    expect(ids(stripGroups(tabs, "connection", groups, { "3": "g1", "4": "g1" }))).toEqual([
      "g1:3,4",
      "connection:prod:1",
      "connection:local:2",
    ]);
  });

  it("keeps the rest in one run when grouping is off", () => {
    expect(ids(stripGroups(tabs, "none", [{ id: "g1", name: "x" }], { "2": "g1" }))).toEqual(["g1:2", "ungrouped:1,3,4"]);
  });

  it("hides an empty manual group unless it's being named", () => {
    const groups = [{ id: "g1", name: "New" }];
    expect(stripGroups(tabs, "connection", groups, {}).some((g) => g.id === "g1")).toBe(false);
    expect(stripGroups(tabs, "connection", groups, {}, "g1")[0]).toMatchObject({ id: "g1", tabs: [] });
  });

  it("treats a membership in a deleted group as no group", () => {
    expect(ids(stripGroups([tab("1", "prod")], "connection", [], { "1": "gone" }))).toEqual(["connection:prod:1"]);
  });
});

describe("pruneGroups", () => {
  it("forgets closed tabs and the groups they emptied", () => {
    const result = pruneGroups(
      [{ id: "g1", name: "a" }, { id: "g2", name: "b" }],
      { "1": "g1", "2": "g2" },
      new Set(["1"]),
    );
    expect(result).toEqual({ groups: [{ id: "g1", name: "a" }], membership: { "1": "g1" } });
  });
});

it("connection group ids name the connection", () => {
  expect(connectionGroupId("abc")).toBe("connection:abc");
});
