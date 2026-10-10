import { useEffect } from "react";
import { useUiStore } from "../../store/uiStore";
import { useAssistantStore } from "../../store/assistantStore";
import { SPLIT_LAYOUT_ORDER } from "../../lib/editorLayout";
import { useEditorLayoutStore } from "../../store/editorLayoutStore";
import { useSessionsStore } from "../../store/sessionsStore";
import { toast } from "sonner";

/**
 * App-wide keys: Ctrl/Cmd+K quick open, Ctrl/Cmd+B the Explorer, Ctrl/Cmd+N
 * a new connection, Ctrl/Cmd+L the Assistant, Ctrl/Cmd+I ask it in place,
 * Ctrl/Cmd+\ the active tab to the side, Ctrl/Cmd+Alt+1-4 a split layout.
 * Ctrl/Cmd+A only selects inside text fields.
 * Caught in the capture phase, before Monaco sees them: it would otherwise
 * swallow Ctrl+K as the start of one of its chords.
 */
/** Focuses an element once it has rendered (the panel loads on first open). */
function focusSoon(id: string, tries = 20) {
  const el = document.getElementById(id);
  if (el) el.focus();
  else if (tries > 0) window.setTimeout(() => focusSoon(id, tries - 1), 50);
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && (target.isContentEditable || !!target.closest(".monaco-editor")))
  );
}

export function useGlobalShortcuts() {
  useEffect(() => {
    /** Ctrl+Alt+1-4 and Ctrl+\: by key position, as Ctrl+Alt is AltGr on many layouts. */
    function onLayoutKey(e: KeyboardEvent): boolean {
      const digit = /^Digit([1-4])$/.exec(e.code);
      if (e.altKey && digit) {
        useEditorLayoutStore.getState().setLayout(SPLIT_LAYOUT_ORDER[Number(digit[1]) - 1]);
        return true;
      }
      if (!e.altKey && e.key === "\\") {
        const active = useSessionsStore.getState().activeTabId;
        if (active && !useEditorLayoutStore.getState().openToSide(active)) {
          toast("All four panes are in use", { description: "Close a pane, or drop the tab onto one to replace it." });
        }
        return true;
      }
      return false;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      // Select all belongs to text fields; elsewhere it would select the whole window.
      if (!e.altKey && e.key.toLowerCase() === "a" && !isEditable(e.target)) {
        e.preventDefault();
        return;
      }
      if (!useUiStore.getState().connectionDialog && onLayoutKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.altKey) return;
      const ui = useUiStore.getState();
      // The connection dialog is modal; nothing opens over it.
      if (ui.connectionDialog) return;
      const key = e.key.toLowerCase();
      if (key === "k") ui.setPaletteOpen(!ui.paletteOpen);
      else if (key === "b") ui.toggleSidePanel("explorer");
      else if (key === "n") {
        ui.setPaletteOpen(false);
        ui.setConnectionDialog({ mode: "new" });
      } else if (key === "l") {
        const assistant = useAssistantStore.getState();
        assistant.togglePanel();
        if (useAssistantStore.getState().panel === "chat") focusSoon("assistant-input");
      } else if (key === "i") {
        useAssistantStore.getState().askInline();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
