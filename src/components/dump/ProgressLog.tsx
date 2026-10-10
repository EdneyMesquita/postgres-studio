import { LoaderCircle } from "lucide-react";
import { formatInt } from "@/lib/format";

interface ProgressLogProps {
  lines: string[];
  objects: number;
  /** "objects" / "tables" in the counter. */
  noun?: string;
}

/** The tool's last output lines, monospaced, with a count of what it handled. */
export function ProgressLog({ lines, objects, noun = "objects" }: ProgressLogProps) {
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <p className="flex items-center gap-1.5 text-sm text-fg-2">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Working…
        <span className="text-fg-3">
          {formatInt(objects)} {noun}
        </span>
      </p>
      <pre className="m-0 h-[7.5rem] overflow-hidden rounded-md border border-line-soft bg-field p-2 font-mono text-xs leading-[1.4] whitespace-pre-wrap break-all text-fg-2">
        {lines.join("\n")}
      </pre>
    </div>
  );
}
