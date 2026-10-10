/**
 * Holds one cursor over the whole window while dragging (a divider, a tree
 * row), so the elements passed over - buttons with their pointer, fields
 * with their text cursor - don't flicker their own.
 */
export function lockCursor(cursor: string) {
  document.body.style.cursor = cursor;
  document.documentElement.classList.add("cursor-locked");
}

export function unlockCursor() {
  document.body.style.cursor = "";
  document.documentElement.classList.remove("cursor-locked");
}
