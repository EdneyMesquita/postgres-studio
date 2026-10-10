import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface QueryFieldProps {
  /** Lowercase caption shown inside the field: filter, sort, limit, skip. */
  label: string;
  /** Id of the native control inside, so clicking the caption focuses it. */
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A query bar field (DESIGN.md query-field): 30px, field tone, a faint
 * inline caption and mono content; the whole box takes the focus ring.
 */
export function QueryField({ label, htmlFor, className, children }: QueryFieldProps) {
  const caption = "shrink-0 pr-2 pl-2.5 text-xs leading-none font-medium tracking-[.02em] text-fg-3 lowercase select-none";
  return (
    <div
      className={cn(
        "flex h-[30px] min-w-0 items-center overflow-hidden rounded-md border border-field-line bg-field transition-[border-color,box-shadow] duration-100",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
        className,
      )}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className={caption}>
          {label}
        </label>
      ) : (
        <span aria-hidden className={caption}>
          {label}
        </span>
      )}
      {children}
    </div>
  );
}
