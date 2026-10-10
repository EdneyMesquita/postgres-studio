import { CircleCheck, Copy, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { PgTool } from "@/types/pg";
import { hostOs, installHint } from "./installHint";

/** The newest PostgreSQL release, for a hint when no server version is known. */
const NEWEST_MAJOR = 18;

/** How to install the client tools here, with the command to copy. */
function InstallHelp({ major }: { major: number }) {
  const hint = installHint(hostOs(), major);
  return (
    <div className="flex flex-col gap-1.5 pl-5 text-sm text-fg-2">
      <span>{hint.text}</span>
      {hint.command && (
        <span className="flex items-center gap-2">
          <code className="rounded-sm bg-fg/7 px-1.5 py-0.5 font-data text-xs text-fg">{hint.command}</code>
          <button
            type="button"
            className="grid size-6 place-items-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
            title="Copy the command"
            aria-label="Copy the command"
            onClick={() =>
              void navigator.clipboard.writeText(hint.command!).then(
                () => toast.success("Copied the command"),
                (e) => toast.error("Couldn't copy", { description: String(e) }),
              )
            }
          >
            <Copy className="size-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}

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
      <div className="flex flex-col gap-1.5">
        <Notice tone="danger">
          <span>
            {name} not found - install the PostgreSQL client tools. Looked in {searched.join(", ")}.
          </span>
        </Notice>
        <InstallHelp major={needsMajor ?? NEWEST_MAJOR} />
      </div>
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
      {tooOld && <InstallHelp major={needsMajor} />}
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
