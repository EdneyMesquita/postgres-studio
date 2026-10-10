import { describe, expect, it } from "vitest";
import {
  closePane,
  openInPane,
  openToSide,
  paneOf,
  pruneTabs,
  showTab,
  SINGLE,
  withLayout,
  type EditorLayout,
} from "./editorLayout";

const split = (panes: (string | null)[], focused = 0): EditorLayout => ({
  layout: panes.length === 2 ? "cols2" : panes.length === 3 ? "cols3" : "grid",
  panes,
  focused,
  maximized: null,
});

describe("withLayout", () => {
  it("puts the active tab in the first pane when splitting", () => {
    expect(withLayout(SINGLE, "cols3", "a")).toEqual({ layout: "cols3", panes: ["a", null, null], focused: 0, maximized: null });
  });

  it("keeps what fits when the layout changes", () => {
    expect(withLayout(split(["a", "b", "c"], 2), "cols2", "c")).toEqual({ layout: "cols2", panes: ["a", "b"], focused: 1, maximized: null });
    expect(withLayout(split(["a", "b"]), "grid", "a").panes).toEqual(["a", "b", null, null]);
  });

  it("goes back to one pane", () => {
    expect(withLayout(split(["a", "b"]), "single", "a")).toEqual(SINGLE);
  });
});

describe("showTab", () => {
  it("puts a tab in the focused pane", () => {
    expect(showTab(split(["a", "b"], 1), "c").panes).toEqual(["a", "c"]);
  });

  it("focuses the pane that already holds the tab", () => {
    const next = showTab(split(["a", "b"], 1), "a");
    expect(next.panes).toEqual(["a", "b"]);
    expect(next.focused).toBe(0);
  });

  it("leaves a single view alone", () => {
    expect(showTab(SINGLE, "a")).toBe(SINGLE);
  });
});

describe("openInPane", () => {
  it("moves a tab from another pane rather than showing it twice", () => {
    expect(openInPane(split(["a", "b", "c"]), "a", 2, "a")).toMatchObject({ panes: [null, "b", "a"], focused: 2 });
  });

  it("splits a single view first", () => {
    expect(openInPane(SINGLE, "b", 1, "a")).toMatchObject({ layout: "cols2", panes: ["a", "b"], focused: 1 });
  });
});

describe("openToSide", () => {
  it("splits beside the active tab", () => {
    expect(openToSide(SINGLE, "b", "a")).toMatchObject({ layout: "cols2", panes: ["a", "b"], focused: 1 });
  });

  it("opens an empty pane beside the active tab itself", () => {
    expect(openToSide(SINGLE, "a", "a")).toMatchObject({ layout: "cols2", panes: ["a", null], focused: 1 });
  });

  it("fills an empty pane, then grows, then stops at four", () => {
    expect(openToSide(split(["a", null]), "b", "a")?.panes).toEqual(["a", "b"]);
    expect(openToSide(split(["a", "b"]), "c", "a")).toMatchObject({ layout: "cols3", panes: ["a", "b", "c"], focused: 2 });
    expect(openToSide(split(["a", "b", "c"]), "d", "a")).toMatchObject({ layout: "grid", panes: ["a", "b", "c", "d"] });
    expect(openToSide(split(["a", "b", "c", "d"]), "e", "a")).toBeNull();
  });
});

describe("closePane", () => {
  it("shrinks the layout and keeps focus on the same tab", () => {
    expect(closePane(split(["a", "b", "c", "d"], 3), 1)).toEqual({ layout: "cols3", panes: ["a", "c", "d"], focused: 2, maximized: null });
  });

  it("goes single when one pane is left", () => {
    expect(closePane(split(["a", "b"]), 0)).toEqual(SINGLE);
  });
});

describe("pruneTabs", () => {
  it("empties the panes of closed tabs", () => {
    expect(pruneTabs(split(["a", "b", "c"]), new Set(["a", "c"])).panes).toEqual(["a", null, "c"]);
  });

  it("goes single when every tab is closed", () => {
    expect(pruneTabs(split(["a", "b"]), new Set())).toEqual(SINGLE);
  });

  it("returns the same layout when nothing closed", () => {
    const state = split(["a", null]);
    expect(pruneTabs(state, new Set(["a", "x"]))).toBe(state);
  });
});

it("paneOf finds a tab's pane", () => {
  expect(paneOf(split(["a", "b"]), "b")).toBe(1);
  expect(paneOf(SINGLE, "a")).toBe(-1);
});
