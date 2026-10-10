import { cn } from "@/lib/utils";

/** Which pane of a split shows a tab: its number, filled blue for the focused pane. */
export function PaneNumber({ pane, focused }: { pane: number; focused: boolean }) {
  return (
    <span
      aria-label={`In pane ${pane + 1}${focused ? ", focused" : ""}`}
      className={cn(
        "inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-sm border px-1 font-mono text-[10px] leading-none font-medium tabular-nums",
        focused ? "border-primary bg-primary text-primary-foreground" : "border-field-line text-fg-2",
      )}
    >
      {pane + 1}
    </span>
  );
}
