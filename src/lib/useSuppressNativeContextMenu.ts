import { useEffect } from "react";

const KEEPS_NATIVE_MENU =
  'input, textarea, [contenteditable=""], [contenteditable="true"], .monaco-editor';

/**
 * Hides the webview's own right-click menu (Back, Reload, Inspect...), which
 * has no place in a desktop app. It stays where it earns its keep: editable
 * fields, for cut/copy/paste, and over a text selection, for copy. Anything
 * that opens a menu of its own calls preventDefault first and is left alone.
 */
export function useSuppressNativeContextMenu() {
  useEffect(() => {
    function onContextMenu(e: MouseEvent) {
      if (e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(KEEPS_NATIVE_MENU)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim() !== "") return;
      e.preventDefault();
    }
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
