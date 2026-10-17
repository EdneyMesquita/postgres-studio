import { describe, expect, it } from "vitest";
import { migrateUi } from "./uiStore";

describe("migrateUi", () => {
  it("drops the result view and keeps the layout", () => {
    expect(migrateUi({ resultView: "tree", consoleLayout: "side", sidebarWidth: 300 })).toEqual({
      consoleLayout: "side",
      sidebarWidth: 300,
    });
  });
});
