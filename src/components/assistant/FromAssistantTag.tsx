import { Sparkles } from "lucide-react";

/** Marks a field or console the Assistant wrote. */
export function FromAssistantTag() {
  return (
    <span
      title="Written by the Assistant"
      className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm bg-accent/12 px-1.5 text-xs font-medium whitespace-nowrap text-accent-text"
    >
      <Sparkles className="size-3" />
      from Assistant
    </span>
  );
}
