import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface WelcomeActionProps {
  /** Leading icon or connection chip. */
  icon: ReactNode;
  children: ReactNode;
  /** Trailing keycap or detail. */
  trailing?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

/** A 34px row in one of the welcome screen's lists. */
export function WelcomeAction({ icon, children, trailing, onClick, disabled }: WelcomeActionProps) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className="-mx-2.5 h-[34px] justify-start gap-2.5 px-2.5 text-fg hover:bg-row-hover [&>svg:first-child]:text-accent-text"
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {trailing && (
        <span className="ml-auto flex min-w-0 max-w-[55%] items-center">{trailing}</span>
      )}
    </Button>
  );
}
