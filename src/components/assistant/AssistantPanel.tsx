import { useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { useAssistantStore } from "../../store/assistantStore";
import { useUiStore } from "../../store/uiStore";
import { AssistantChat } from "./AssistantChat";
import { AssistantResizer } from "./AssistantResizer";
import { AssistantSetup } from "./AssistantSetup";

/** The editor never gets narrower than this beside the panel; below, the panel floats over it. */
const MIN_EDITOR = 520;
/** The tool stripe on the left edge. */
const STRIPE = 40;

function subscribeResize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/**
 * The Assistant tool window, docked right of the editor, or over it when
 * docking would leave the editor too narrow. Loaded on first open, so the
 * app starts without it.
 */
export default function AssistantPanel() {
  const view = useAssistantStore((s) => s.panel);
  const width = useAssistantStore((s) => s.panelWidth);
  const sidebar = useUiStore((s) => (s.sidePanel ? s.sidebarWidth : 0));
  const windowWidth = useSyncExternalStore(subscribeResize, () => window.innerWidth);
  // Under 960px the side panel floats itself, so it takes no room here.
  const docked = windowWidth - STRIPE - (windowWidth < 960 ? 0 : sidebar) - width >= MIN_EDITOR;

  // Ctrl/Cmd+Enter anywhere in the panel uses the latest proposal.
  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-proposal-primary]:not(:disabled)");
    const last = buttons[buttons.length - 1];
    if (!last) return;
    e.preventDefault();
    last.click();
  }

  return (
    <aside
      aria-label={view === "setup" ? "Assistant settings" : "Assistant"}
      onKeyDown={onKeyDown}
      className={cn(
        "relative flex max-w-[calc(100%-40px)] shrink-0 flex-col border-l border-seam bg-panel",
        !docked && "absolute inset-y-0 right-0 z-30 shadow-overlay",
      )}
      style={{ width }}
    >
      <AssistantResizer width={width} />
      {view === "setup" ? <AssistantSetup /> : <AssistantChat />}
    </aside>
  );
}
