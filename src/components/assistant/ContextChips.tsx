import { Braces, Funnel, SquareTerminal, Table2, X } from "lucide-react";
import type { ContextItem } from "../../store/assistantStore";

export function ContextChipIcon({ kind }: { kind: ContextItem["kind"] }) {
  const Icon = kind === "filter" ? Funnel : kind === "row" ? Braces : kind === "result" ? SquareTerminal : Table2;
  return <Icon className="size-3 shrink-0" aria-hidden />;
}

/** Attached context waiting for the next message; each one can be removed. */
export function AttachedChip({ item, onRemove }: { item: ContextItem; onRemove: () => void }) {
  return (
    <span className="inline-flex h-[22px] max-w-40 items-center gap-[5px] rounded-sm bg-fg/7 pr-0.5 pl-[7px] text-xs text-fg-2">
      <ContextChipIcon kind={item.kind} />
      <span className="truncate">{item.label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.label}`}
        title="Remove"
        className="grid size-4 place-items-center rounded-sm text-fg-3 hover:bg-hover hover:text-fg"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
