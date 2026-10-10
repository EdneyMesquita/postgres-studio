import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "../types/pg";
import {
  canRefreshConcurrently,
  defaultIndexName,
  deleteTemplateSql,
  dropIndexSql,
  dropTriggerSql,
  insertTemplateSql,
  newIndexSql,
  qualify,
  quote,
  refreshMatviewSql,
  selectAllSql,
  toggleTriggerSql,
  updateTemplateSql,
} from "./objectsSql";

function col(name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
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
    ...extra,
  };
}

describe("quote", () => {
  it("leaves plain lowercase words alone", () => {
    expect(quote("orders")).toBe("orders");
    expect(quote("_x1$")).toBe("_x1$");
  });
  it("quotes what is not plain", () => {
    expect(quote("Order Items")).toBe('"Order Items"');
    expect(quote("Orders")).toBe('"Orders"');
    expect(quote("1st")).toBe('"1st"');
  });
  it("doubles embedded quotes", () => {
    expect(quote('we"ird')).toBe('"we""ird"');
  });
  it("quotes keywords a name can't be", () => {
    expect(quote("user")).toBe('"user"');
    expect(quote("order")).toBe('"order"');
    expect(quote("left")).toBe('"left"');
    expect(quote("name")).toBe("name");
  });
  it("qualifies both parts", () => {
    expect(qualify("Sales", "order")).toBe('"Sales"."order"');
  });
});

describe("triggers", () => {
  it("enables, disables and drops with quoted names", () => {
    expect(toggleTriggerSql("public", "Orders", "audit trg", false)).toBe('ALTER TABLE public."Orders" DISABLE TRIGGER "audit trg";\n');
    expect(toggleTriggerSql("public", "t", "trg", true)).toBe("ALTER TABLE public.t ENABLE TRIGGER trg;\n");
    expect(dropTriggerSql("public", "t", 'a"b')).toBe('DROP TRIGGER "a""b" ON public.t;\n');
  });
});

describe("indexes", () => {
  it("drops a plain index concurrently", () => {
    expect(dropIndexSql("public", "t", { name: "t_a_idx", constraint: null })).toContain("DROP INDEX CONCURRENTLY IF EXISTS public.t_a_idx;");
  });
  it("drops the constraint behind an index instead", () => {
    const sql = dropIndexSql("public", "t", { name: "t_pkey", constraint: "t_pkey" });
    expect(sql).toContain("ALTER TABLE public.t DROP CONSTRAINT t_pkey;");
    expect(sql).not.toMatch(/^DROP INDEX/m);
  });
  it("builds CREATE INDEX CONCURRENTLY from columns and a method", () => {
    const sql = newIndexSql({ schema: "public", table: "Orders", name: "orders_idx", method: "gin", columns: ["tags", "Full Name"] });
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_idx\n  ON public."Orders" USING gin (tags, "Full Name");');
    expect(newIndexSql({ schema: "s", table: "t", name: "u", method: "btree", columns: ["a"], unique: true })).toContain("CREATE UNIQUE INDEX CONCURRENTLY");
  });
  it("names an index after its table and columns within 63 bytes", () => {
    expect(defaultIndexName("orders", ["status", "created_at"])).toBe("orders_status_created_at_idx");
    const long = defaultIndexName("t".repeat(80), ["a"]);
    expect(long.length).toBe(63);
    expect(long.endsWith("_idx")).toBe(true);
    expect(defaultIndexName("My Table", ["a b"])).toBe("My_Table_a_b_idx");
  });
});

describe("materialized views", () => {
  const unique = { unique: true, valid: true, partial: false, expression: false };
  it("refreshes concurrently only with a usable unique index", () => {
    expect(canRefreshConcurrently([unique])).toBe(true);
    expect(canRefreshConcurrently([])).toBe(false);
    expect(canRefreshConcurrently([{ ...unique, unique: false }])).toBe(false);
    expect(canRefreshConcurrently([{ ...unique, partial: true }])).toBe(false);
    expect(canRefreshConcurrently([{ ...unique, expression: true }])).toBe(false);
    expect(canRefreshConcurrently([{ ...unique, valid: false }])).toBe(false);
  });
  it("writes the matching statement", () => {
    expect(refreshMatviewSql("public", "mv", [unique])).toContain("REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv;");
    expect(refreshMatviewSql("public", "mv", [])).toContain("REFRESH MATERIALIZED VIEW public.mv;");
  });
});

describe("table templates", () => {
  const t = {
    schema: "public",
    name: "Order",
    rowKey: ["id"],
    columns: [
      col("id", { typeName: "bigint", nullable: false, identity: "a" }),
      col("note"),
      col("total", { typeName: "numeric", nullable: false, default: "0" }),
      col("gen", { generated: "total * 2" }),
    ],
  };
  it("selects every column", () => {
    expect(selectAllSql(t)).toBe('SELECT\n  id,\n  note,\n  total,\n  gen\nFROM public."Order"\nLIMIT 100;\n');
  });
  it("inserts only writable columns, with DEFAULT where one exists", () => {
    const sql = insertTemplateSql(t);
    expect(sql).toContain('INSERT INTO public."Order" (\n  note,\n  total\n)');
    expect(sql).toContain("NULL, -- text");
    expect(sql).toContain("DEFAULT -- numeric, not null");
    expect(sql).not.toContain("gen");
  });
  it("updates by the key, with a placeholder that matches nothing", () => {
    const sql = updateTemplateSql(t);
    expect(sql).toContain("SET\n  note = note,\n  total = total\nWHERE id = NULL;");
  });
  it("deletes by the key", () => {
    expect(deleteTemplateSql(t)).toContain('DELETE FROM public."Order"\nWHERE id = NULL;');
  });
  it("writes a harmless condition for a table with no key", () => {
    expect(deleteTemplateSql({ ...t, rowKey: [] })).toContain("WHERE false --");
    expect(updateTemplateSql({ ...t, rowKey: ["id", "note"] })).toContain("WHERE id = NULL\n  AND note = NULL;");
  });
});
