import { describe, expect, it } from "vitest";
import { matchKeywords, matchScore, topMatches } from "./paletteMatch";

const item = (label: string, where = "local dev") => ({
  label: label.toLowerCase(),
  haystack: `${label.toLowerCase()} ${where}`,
});

describe("matchScore", () => {
  it("ranks a label that starts with the query above one that contains it", () => {
    expect(matchScore("shop", "shop.orders", "shop.orders local")).toBe(1);
    expect(matchScore("orders", "shop.orders", "shop.orders local")).toBe(0.8);
  });

  it("needs every word somewhere, in any order", () => {
    expect(matchScore("orders local", "shop.orders", "shop.orders local")).toBe(0.5);
    expect(matchScore("orders staging", "shop.orders", "shop.orders local")).toBe(0);
  });

  it("matches everything when nothing is typed", () => {
    expect(matchScore("", "shop.orders", "shop.orders")).toBe(1);
  });
});

describe("matchKeywords", () => {
  it("reads cmdk's keywords: the label first, then where it lives", () => {
    expect(matchKeywords("action:theme", "  Switch ", ["Switch to light theme"])).toBe(1);
    expect(matchKeywords("collection:x", "prod", ["shop.orders", "Production EU"])).toBe(0.5);
    expect(matchKeywords("collection:x", "nope", ["shop.orders", "Production EU"])).toBe(0);
  });
});

describe("topMatches", () => {
  it("puts better ranks first, in list order within a rank", () => {
    const items = [item("a.provisioning_log"), item("a.credit_provisioning"), item("provisioning.x"), item("b.other")];
    const { items: found, total } = topMatches(items, "provisioning", 10);
    expect(found.map((i) => i.label)).toEqual(["provisioning.x", "a.provisioning_log", "a.credit_provisioning"]);
    expect(total).toBe(3);
  });

  it("returns at most the limit but counts every match", () => {
    const items = Array.from({ length: 17_000 }, (_, i) => item(`db.shared_${i}`));
    const { items: found, total } = topMatches(items, "shared", 50);
    expect(found).toHaveLength(50);
    expect(total).toBe(17_000);
  });

  it("keeps a late better match within the limit", () => {
    const items = [...Array.from({ length: 100 }, (_, i) => item(`db.x_logs_${i}`)), item("logs.latest")];
    const { items: found } = topMatches(items, "logs", 5);
    expect(found[0].label).toBe("logs.latest");
    expect(found).toHaveLength(5);
  });

  it("shows the first items when nothing is typed", () => {
    const items = [item("a.one"), item("a.two"), item("a.three")];
    expect(topMatches(items, "  ", 2)).toEqual({ items: items.slice(0, 2), total: 3 });
  });
});
