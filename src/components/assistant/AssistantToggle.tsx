import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAssistantStore } from "../../store/assistantStore";

/** The toolbar's Assistant button: opens the panel, or its setup on first use. */
export function AssistantToggle() {
  const open = useAssistantStore((s) => s.panel !== null);
  const toggle = useAssistantStore((s) => s.togglePanel);
  return (
    <Button variant="ghost" aria-pressed={open} title="Assistant (Ctrl L)" onClick={() => toggle()}>
      <Sparkles className="size-3.5" />
      <span>Assistant</span>
    </Button>
  );
}
