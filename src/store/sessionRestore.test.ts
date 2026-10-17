import { describe, expect, it } from "vitest";
import { restoredTabs } from "./sessionRestore";

const profiles = [{ id: "c1", name: "Local dev", summary: "postgres://localhost:5433/shop" }];

describe("restoredTabs", () => {
  it("brings tabs back dormant, with their query and SQL, for connections that still exist", () => {
    const { tabs, consoles, views } = restoredTabs(
      {
        version: 1,
        activeTabId: "t1",
        tabs: [
          {
            kind: "table",
            id: "t1",
            connectionId: "c1",
            database: "shop",
            schema: "public",
            table: "orders",
            relkind: "r",
            view: "sql",
            whereText: "status <> 'cancelled'",
            orderByText: "placed_at DESC",
            limit: 200,
            offset: 400,
            script: "SELECT 1;",
            file: null,
          },
          { kind: "console", id: "k1", connectionId: "c1", database: "shop", number: 2, script: null, file: null, engine: "psql" },
          { kind: "diagram", id: "d1", connectionId: "c1", database: "shop", schema: "public", focus: "orders" },
          { kind: "activity", id: "a1", connectionId: "gone", database: "shop", view: "locks" },
        ],
      },
      profiles,
    );
    expect(tabs.map((t) => t.id)).toEqual(["t1", "k1", "d1"]);
    expect(tabs.every((t) => t.dormant)).toBe(true);
    const table = tabs[0];
    if (table.kind !== "table") throw new Error("not a table tab");
    expect([table.whereText, table.orderByText, table.limit, table.offset]).toEqual(["status <> 'cancelled'", "placed_at DESC", 200, 400]);
    expect(table.connection.name).toBe("Local dev");
    expect(views).toEqual({ t1: "sql" });
    expect(consoles.t1.script).toBe("SELECT 1;");
    expect(consoles.k1.engine).toBe("psql");
  });
});
