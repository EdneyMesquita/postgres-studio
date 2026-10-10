import { cn } from "@/lib/utils";

interface ProgressBarProps {
  /** 0 to 1; undefined shows a bar that is not filling. */
  value: number | undefined;
  label: string;
  className?: string;
}

/** A thin determinate bar. */
export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const percent = value === undefined ? 0 : Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === undefined ? undefined : percent}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-fg/10", className)}
    >
      <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${percent}%` }} />
    </div>
  );
}
