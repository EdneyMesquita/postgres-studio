import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ToolStripeButtonProps {
  label: string;
  /** Shortcut shown in the tooltip, e.g. "Ctrl B". */
  shortcut?: string;
  /** Omitted for a plain action (not a tool-window toggle). */
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** A 30px tool-window toggle; the pressed one carries an accent bar on its left. */
export function ToolStripeButton({ label, shortcut, pressed, onClick, children }: ToolStripeButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className="relative size-[30px] p-0 aria-pressed:before:absolute aria-pressed:before:inset-y-[7px] aria-pressed:before:-left-[5px] aria-pressed:before:w-0.5 aria-pressed:before:rounded-full aria-pressed:before:bg-accent"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
        {shortcut && <span className="ml-2 text-fg-3">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
