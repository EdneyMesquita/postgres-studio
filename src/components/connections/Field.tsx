import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface FieldProps {
  label: string;
  /** The control's id; without one the children are labelled as a group. */
  htmlFor?: string;
  /** Faint line under the control. */
  help?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A label, its control and optional help, stacked 6px apart. */
export function Field({ label, htmlFor, help, className, children }: FieldProps) {
  const labelId = useId();
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
      role={htmlFor ? undefined : "group"}
      aria-labelledby={htmlFor ? undefined : labelId}
    >
      {htmlFor ? (
        <Label htmlFor={htmlFor} className="leading-[1.45]">
          {label}
        </Label>
      ) : (
        <span id={labelId} className="text-sm leading-[1.45] font-medium text-fg">
          {label}
        </span>
      )}
      {children}
      {help && (
        <p className="flex items-center gap-[5px] text-xs text-fg-3 [&_svg]:size-3 [&_svg]:shrink-0">
          {help}
        </p>
      )}
    </div>
  );
}
