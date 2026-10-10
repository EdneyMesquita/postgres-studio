import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { ConnectionImportPreview } from "@/types/connection";

interface ImportPreviewRowProps {
  entry: ConnectionImportPreview;
  checked: boolean;
  onToggle: () => void;
}

/** One connection found in an import file, ticked to import it. */
export function ImportPreviewRow({ entry, checked, onToggle }: ImportPreviewRowProps) {
  const blocked = entry.error !== null;
  return (
    <li className="border-b border-line-soft last:border-b-0">
      <label
        className={cn(
          "flex items-start gap-2.5 px-2.5 py-1.5",
          blocked ? "cursor-not-allowed" : "cursor-pointer hover:bg-row-hover",
        )}
      >
        <Checkbox className="mt-[3px]" checked={checked} disabled={blocked} onCheckedChange={onToggle} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate text-base", blocked ? "text-fg-2" : "text-fg")}>
              {entry.name || "(unnamed)"}
            </span>
            {entry.exists && (
              <span className="shrink-0 rounded-sm bg-warn/12 px-1.5 text-2xs leading-4 text-warn">
                already saved
              </span>
            )}
            {entry.warning && !blocked && (
              <span className="shrink-0 rounded-sm bg-warn/12 px-1.5 text-2xs leading-4 text-warn">
                needs attention
              </span>
            )}
            {blocked && (
              <span className="shrink-0 rounded-sm bg-danger/12 px-1.5 text-2xs leading-4 text-danger">
                can't import
              </span>
            )}
          </span>
          {entry.address && (
            <span className="truncate font-data text-fg-3" title={entry.address}>
              {entry.address}
            </span>
          )}
          {entry.warning && <span className="text-xs text-warn">{entry.warning}</span>}
          {entry.error && <span className="text-xs text-danger">Can't import: {entry.error}</span>}
        </span>
      </label>
    </li>
  );
}
