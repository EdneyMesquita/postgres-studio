import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

interface PanelNoticeProps {
  tone?: "warn" | "danger";
  children: ReactNode;
}

/** A compact warning or error at the top of a tool window. */
export function PanelNotice({ tone = "warn", children }: PanelNoticeProps) {
  const text = typeof children === "string" ? children : undefined;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      title={text}
      className={cn(
        "mx-2 mb-2 flex shrink-0 items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs",
        tone === "danger"
          ? "border-danger/40 bg-danger/10 text-danger"
          : "border-warn/40 bg-warn/10 text-warn",
      )}
    >
      <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
      <span className="line-clamp-3 min-w-0 break-words">{children}</span>
    </div>
  );
}
