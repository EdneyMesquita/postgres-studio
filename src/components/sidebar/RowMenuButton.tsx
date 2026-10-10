import { ActionMenuButton } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";

interface RowMenuButtonProps {
  entries: () => MenuEntry[];
  /** Accessible name, e.g. "Actions for Local dev". */
  label: string;
}

/** A tree row's "..." menu, shown while the row is hovered or focused. */
export function RowMenuButton({ entries, label }: RowMenuButtonProps) {
  return (
    // Clicks, keys and presses on the button and its menu (portaled, but
    // bubbling through React) are theirs, not the row's: those would
    // toggle, connect, rename or start a drag.
    <span
      className="flex"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <ActionMenuButton
        entries={entries}
        label={label}
        className="opacity-0 group-has-[:focus-visible]:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
      />
    </span>
  );
}
