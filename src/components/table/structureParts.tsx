import type { ReactNode } from "react";

export function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="sticky top-0 z-[3] flex h-[34px] items-center gap-1.5 border-t border-line-soft bg-editor pr-2.5 pl-3.5 text-sm font-semibold text-fg-2 first:border-t-0">
        {title}
        {count !== undefined && <span className="font-normal text-fg-3">{count}</span>}
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

export const th = "sticky top-[34px] z-[2] h-[30px] bg-panel px-3.5 text-left text-sm font-medium whitespace-nowrap text-fg-2 border-b border-line";
export const td = "h-[30px] border-b border-line-soft px-3.5 align-middle";

/** A relation's name that opens its tab. */
export function RelationLink({ children, title, onClick }: { children: ReactNode; title?: string; onClick: () => void }) {
  return (
    <button type="button" title={title} onClick={onClick} className="font-data text-accent-text hover:underline">
      {children}
    </button>
  );
}
