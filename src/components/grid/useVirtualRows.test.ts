import { describe, expect, it } from "vitest";
import { rowWindow } from "./useVirtualRows";

const ROW = 25;
const view = (top: number) => ({ top, height: 500 });
/** Total scroll height a window stands for: spacers plus rendered rows and the open document. */
function height(w: ReturnType<typeof rowWindow>, open: { index: number; height: number } | null) {
  const inside = open && open.index >= w.start && open.index < w.end ? open.height : 0;
  return w.padTop + (w.end - w.start) * ROW + inside + w.padBottom;
}

describe("rowWindow", () => {
  it("windows evenly without an open document", () => {
    const w = rowWindow(1000, ROW, view(250 * ROW), null);
    expect(w.start).toBe(238);
    expect(w.padTop).toBe(238 * ROW);
    expect(height(w, null)).toBe(1000 * ROW);
  });

  it("keeps the total height true with a document open above, inside or below the window", () => {
    const open = { index: 120, height: 320 };
    for (const top of [0, 100 * ROW, 121 * ROW + 100, 121 * ROW + 320, 400 * ROW, 975 * ROW]) {
      const w = rowWindow(1000, ROW, view(top), open);
      expect(height(w, open), `top ${top}`).toBe(1000 * ROW + 320);
    }
  });

  it("shifts the rows after the open document by its height", () => {
    const open = { index: 120, height: 320 };
    // scrolled so row 200 is at the top: past the document
    const w = rowWindow(1000, ROW, view(200 * ROW + 320), open);
    expect(w.start).toBe(200 - 12);
    expect(w.padTop).toBe((200 - 12) * ROW + 320);
  });

  it("keeps the open row rendered while scrolling through its document", () => {
    const open = { index: 120, height: 320 };
    const w = rowWindow(1000, ROW, view(121 * ROW + 150), open);
    expect(w.start).toBeLessThanOrEqual(120);
    expect(w.end).toBeGreaterThan(120);
  });
});
