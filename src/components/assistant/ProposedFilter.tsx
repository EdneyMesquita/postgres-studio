import { changedSpan } from "../../lib/assistant/diff";

/** A proposed WHERE condition in place of the field, what changed highlighted. */
export function ProposedFilter({ original, proposal }: { original: string; proposal: string }) {
  const { start, end } = changedSpan(original, proposal);
  return (
    <div
      title="Proposed condition"
      className="flex min-h-[30px] min-w-[200px] flex-1 items-start overflow-hidden rounded-md border border-ok/70 bg-field py-[5px] max-sm:order-first max-sm:basis-full @max-[820px]:order-first @max-[820px]:basis-full"
    >
      <span aria-hidden className="shrink-0 pr-2 pl-2.5 text-xs leading-[18px] font-medium tracking-[.02em] text-fg-3 lowercase select-none">
        where
      </span>
      <span className="min-w-0 flex-1 pr-2 font-mono text-data leading-[18px] break-words whitespace-normal [font-variant-ligatures:none] [overflow-wrap:anywhere]">
        {proposal.slice(0, start)}
        {end > start && <span className="rounded-[2px] bg-ok/22">{proposal.slice(start, end)}</span>}
        {proposal.slice(end)}
      </span>
    </div>
  );
}
