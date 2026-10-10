import type { ReactNode } from "react";

/** A subsection heading inside a form section, e.g. "Authentication". */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mt-1 -mb-1.5 text-sm font-semibold text-fg-2">{children}</h3>;
}
