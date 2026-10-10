import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { TREE_INDENT_PX } from "./TreeRow";

interface TreeNoteProps {
  depth: number;
  tone?: "faint" | "danger";
  children: ReactNode;
}

/** A one-line note in the tree - loading, empty, an error - under a row. */
export function TreeNote({ depth, tone = "faint", children }: TreeNoteProps) {
  return (
    <div
      role="none"
      className={cn(
        "flex h-6 items-center pr-2 text-xs",
        tone === "danger" ? "text-danger" : "text-fg-3",
      )}
      // lines up with the labels of the rows at this depth
      style={{ paddingLeft: 6 + depth * TREE_INDENT_PX + 22 }}
      title={typeof children === "string" ? children : undefined}
    >
      <span className="truncate">{children}</span>
    </div>
  );
}
