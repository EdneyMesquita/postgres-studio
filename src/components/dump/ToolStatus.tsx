import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { PgTool } from "@/types/pg";

interface ToolStatusProps {
  /** "pg_dump" */
  name: string;
  /** Copies found, newest first; null while looking. */
  found: PgTool[] | null;
  searched: string[];
  /** What the copy has to be at least, e.g. the server's major version. */
  needsMajor?: number | null;
}

/** Whether a client tool is installed, which copy is used, and why not. */
export function ToolStatus({ name, found, searched, needsMajor }: ToolStatusProps) {
  if (found === null) return <p className="text-sm text-fg-3">Looking for {name}…</p>;
  const best = found[0];
  if (!best) {
    return (
      <Notice tone="danger">
        <span>
          {name} not found - install the PostgreSQL client tools. Looked in {searched.join(", ")}.
        </span>
      </Notice>
    );
  }
  const tooOld = needsMajor != null && best.major < needsMajor;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-sm text-fg-2" title={best.path}>
        <CircleCheck className="size-3.5 shrink-0 text-ok" aria-hidden />
        <span className="min-w-0 truncate">
          {name} {best.version}
          <span className="text-fg-3"> · {best.path}</span>
        </span>
      </p>
      {tooOld && (
        <Notice tone="warn">
          <span>
            The newest {name} is version {best.major}, older than this server (version {needsMajor}).
            Install the PostgreSQL {needsMajor} client tools.
          </span>
        </Notice>
      )}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "warn" | "danger"; children: ReactNode }) {
  return (
    <p
      role={tone === "danger" ? "alert" : undefined}
      className={`flex items-start gap-1.5 text-sm ${tone === "danger" ? "text-danger" : "text-warn"}`}
    >
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}
