import { describe, expect, it } from "vitest";
import type { DiagramColumn, DiagramForeignKey, DiagramTable } from "../types/pg";
import { BOX_W, MAX_COLUMNS, layoutDiagram, neighbourhood, shortType } from "./diagramLayout";

const col = (name: string, extra: Partial<DiagramColumn> = {}): DiagramColumn => ({
  name,
  type: "bigint",
  notNull: false,
  pk: false,
  fk: false,
  ...extra,
});
const table = (name: string, columns: DiagramColumn[]): DiagramTable => ({ name, kind: "r", rowEstimate: 10, columns });
const fk = (from: string, column: string, to: string, schema = "public"): DiagramForeignKey => ({
  name: `${from}_${column}_fkey`,
  table: from,
  columns: [column],
  refSchema: schema,
  refTable: to,
  refColumns: ["id"],
});

const shop = [
  table("customers", [col("id", { pk: true }), col("name", { type: "text" })]),
  table("orders", [col("id", { pk: true }), col("customer_id", { fk: true })]),
  table("order_items", [col("id", { pk: true }), col("order_id", { fk: true }), col("product_id", { fk: true })]),
  table("products", [col("id", { pk: true })]),
  table("settings", [col("key", { type: "text", pk: true })]),
];
const keys = [fk("orders", "customer_id", "customers"), fk("order_items", "order_id", "orders"), fk("order_items", "product_id", "products")];

describe("layoutDiagram", () => {
  it("puts referenced tables left of the tables pointing at them", () => {
    const { boxes } = layoutDiagram("public", shop, keys);
    const x = (n: string) => boxes.find((b) => b.name === n)!.x;
    expect(x("customers")).toBeLessThan(x("orders"));
    expect(x("orders")).toBeLessThan(x("order_items"));
    expect(x("products")).toBeLessThan(x("order_items"));
    // a table with no keys goes after the linked ones
    expect(x("settings")).toBeGreaterThan(x("order_items"));
  });

  it("draws one edge per key, from the key column's row", () => {
    const { boxes, edges } = layoutDiagram("public", shop, keys);
    expect(edges).toHaveLength(3);
    const items = boxes.find((b) => b.name === "order_items")!;
    const edge = edges.find((e) => e.key.columns[0] === "order_id")!;
    // order_id is the second row of order_items
    expect(edge.d.startsWith(`M ${items.x} ${items.y + 30 + 22 + 11} `)).toBe(true);
  });

  it("survives a cycle and a key pointing at its own table", () => {
    const tables = [table("a", [col("id", { pk: true }), col("b_id", { fk: true }), col("parent_id", { fk: true })]), table("b", [col("id", { pk: true }), col("a_id", { fk: true })])];
    const cyc = [fk("a", "b_id", "b"), fk("b", "a_id", "a"), fk("a", "parent_id", "a")];
    const { boxes, edges } = layoutDiagram("public", tables, cyc);
    expect(boxes).toHaveLength(2);
    expect(edges).toHaveLength(3);
    for (const e of edges) expect(e.d).not.toMatch(/NaN|undefined/);
  });

  it("shows a key into another schema as a stub", () => {
    const tables = [table("events", [col("id", { pk: true }), col("user_id", { fk: true })])];
    const { boxes, edges } = layoutDiagram("public", tables, [fk("events", "user_id", "users", "auth")]);
    const stub = boxes.find((b) => b.stub)!;
    expect(stub.label).toBe("auth.users");
    expect(edges[0].to).toBe("auth.users");
  });

  it("caps tall tables but keeps their keys", () => {
    const many = [col("id", { pk: true }), ...Array.from({ length: 30 }, (_, i) => col(`c${i}`)), col("owner_id", { fk: true })];
    const { boxes } = layoutDiagram("public", [table("wide", many)], []);
    const wide = boxes[0];
    expect(wide.columns.length).toBe(MAX_COLUMNS - 1);
    expect(wide.hidden).toBe(many.length - (MAX_COLUMNS - 1));
    expect(wide.columns.some((c) => c.name === "owner_id")).toBe(true);
  });

  it("skips keys whose tables are filtered out", () => {
    const near = neighbourhood("orders", keys, "public");
    expect([...near].sort()).toEqual(["customers", "order_items", "orders"]);
    const { boxes, edges } = layoutDiagram("public", shop.filter((t) => near.has(t.name)), keys);
    expect(boxes.map((b) => b.name).sort()).toEqual(["customers", "order_items", "orders"]);
    expect(edges).toHaveLength(2);
    expect(Math.min(...boxes.map((b) => b.x))).toBeGreaterThan(0);
    expect(BOX_W).toBeGreaterThan(0);
  });
});

describe("shortType", () => {
  it("shortens the long spellings", () => {
    expect(shortType("timestamp with time zone")).toBe("timestamptz");
    expect(shortType("character varying(40)")).toBe("varchar(40)");
    expect(shortType("character(2)")).toBe("char(2)");
    expect(shortType("numeric(12,2)")).toBe("numeric(12,2)");
  });
});
