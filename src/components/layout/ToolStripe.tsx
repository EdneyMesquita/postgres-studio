import { ArrowLeftRight, Database, FileCode } from "lucide-react";
import { useUiStore } from "../../store/uiStore";
import { ToolStripeButton } from "./ToolStripeButton";

/** The 40px strip of tool-window toggles on the window's left edge. */
export function ToolStripe() {
  const sidePanel = useUiStore((s) => s.sidePanel);
  const toggleSidePanel = useUiStore((s) => s.toggleSidePanel);
  return (
    <nav
      aria-label="Tool windows"
      className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-seam bg-panel py-1.5"
    >
      <ToolStripeButton
        label="Explorer"
        shortcut="Ctrl B"
        pressed={sidePanel === "explorer"}
        onClick={() => toggleSidePanel("explorer")}
      >
        <Database />
      </ToolStripeButton>
      <ToolStripeButton
        label="Saved scripts"
        pressed={sidePanel === "scripts"}
        onClick={() => toggleSidePanel("scripts")}
      >
        <FileCode />
      </ToolStripeButton>
      <span className="flex-1" />
      <ToolStripeButton
        label="Import / export connections"
        onClick={() => useUiStore.getState().setImportExportOpen(true)}
      >
        <ArrowLeftRight />
      </ToolStripeButton>
    </nav>
  );
}
