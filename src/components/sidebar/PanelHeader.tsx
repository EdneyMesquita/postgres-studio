import type { ReactNode } from "react";

interface PanelHeaderProps {
  title: string;
  /** Icon buttons at the right. */
  children?: ReactNode;
}

/** A tool window's 36px title bar with its actions. */
export function PanelHeader({ title, children }: PanelHeaderProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 pl-3 pr-1.5">
      <h2 className="flex-1 truncate text-base font-semibold text-fg">{title}</h2>
      {children}
    </div>
  );
}
