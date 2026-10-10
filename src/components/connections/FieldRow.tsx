import type { ReactNode } from "react";

/** Two fields side by side. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3.5">{children}</div>;
}
