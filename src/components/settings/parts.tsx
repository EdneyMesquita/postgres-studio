import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A section's opening line, in secondary text. */
export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("m-0 text-sm leading-normal text-fg-2", className)}>{children}</p>;
}

/** A faint note under a group, pulled up toward it. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="m-0 -mt-2 text-xs leading-normal text-fg-3">{children}</p>;
}

/** A shield-style aside: what leaves the machine, how something stays safe. */
export function Aside({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-fg/5 p-2.5 text-sm leading-normal text-fg-2 [&>svg]:mt-0.5 [&>svg]:size-3.5 [&>svg]:shrink-0 [&_b]:font-medium [&_b]:text-fg">
      {icon}
      <div>{children}</div>
    </div>
  );
}

/** A setting on one line: what it is on the left, its action on the right. */
export function SettingRow({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-line-soft py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <b className="block font-medium">{title}</b>
        <span className="text-sm leading-[1.45] text-fg-3">{description}</span>
      </div>
      {children}
    </div>
  );
}

/** A bordered list of rows with an optional heading strip. */
export function RowGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-line">
      {title && (
        <div className="flex h-7 items-center border-b border-line-soft bg-panel px-3 text-xs font-semibold text-fg-2">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

/** One row of a RowGroup: a title, an optional line under it, and a control. */
export function GroupRow({
  leading,
  title,
  description,
  children,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3 border-b border-line-soft py-[9px] pr-2.5 pl-3 last:border-b-0", className)}>
      {leading}
      <div className="min-w-0 flex-1">
        <b className="block truncate font-medium">{title}</b>
        {description && <span className="mt-px block truncate text-sm leading-[1.4] text-fg-3">{description}</span>}
      </div>
      {children}
    </div>
  );
}
