import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ImportPreviewRow } from "./ImportPreviewRow";
import type { PendingImport } from "./useConnectionsTransfer";

interface ImportPreviewListProps {
  pending: PendingImport;
  importableCount: number;
  allSelected: boolean;
  onToggle: (index: number) => void;
  onToggleAll: () => void;
}

/** What an import file holds, with a checkbox per connection. */
export function ImportPreviewList({
  pending,
  importableCount,
  allSelected,
  onToggle,
  onToggleAll,
}: ImportPreviewListProps) {
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="flex h-8 items-center justify-between border-b border-line bg-panel px-2.5 text-sm text-fg-2">
        <Label className="font-normal text-fg-2">
          <Checkbox
            checked={allSelected}
            disabled={importableCount === 0}
            onCheckedChange={onToggleAll}
          />
          Select all
        </Label>
        <span className="tabular-nums">
          {pending.selected.size} of {pending.entries.length} selected
        </span>
      </div>
      {/* Scrolls on its own so a long file doesn't push the footer away. */}
      <ul className="max-h-72 overflow-y-auto">
        {pending.entries.map((entry) => (
          <ImportPreviewRow
            key={entry.index}
            entry={entry}
            checked={pending.selected.has(entry.index)}
            onToggle={() => onToggle(entry.index)}
          />
        ))}
      </ul>
    </div>
  );
}
