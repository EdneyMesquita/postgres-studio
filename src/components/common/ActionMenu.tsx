import { useState } from "react";
import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface MenuAction {
  label: string;
  onSelect: () => void;
  icon?: LucideIcon;
  /** Shortcut hint at the right, e.g. "Ctrl N". */
  shortcut?: string;
  /** Destructive: red, filling red when highlighted. */
  danger?: boolean;
  disabled?: boolean;
}

/** A menu row: an action, a rule between groups, or a group heading. */
export type MenuEntry = MenuAction | { separator: true } | { heading: string };

type Parts = {
  Item: typeof ContextMenuItem | typeof DropdownMenuItem;
  Label: typeof ContextMenuLabel | typeof DropdownMenuLabel;
  Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator;
  Shortcut: typeof ContextMenuShortcut | typeof DropdownMenuShortcut;
};

function Entries({ entries, parts }: { entries: MenuEntry[]; parts: Parts }) {
  const { Item, Label, Separator, Shortcut } = parts;
  return entries.map((entry, i) => {
    if ("separator" in entry) return <Separator key={`sep-${i}`} />;
    if ("heading" in entry) {
      return (
        <Label key={`head-${i}`} className="truncate">
          {entry.heading}
        </Label>
      );
    }
    const Icon = entry.icon;
    return (
      <Item
        key={entry.label}
        disabled={entry.disabled}
        variant={entry.danger ? "destructive" : "default"}
        onSelect={entry.onSelect}
      >
        {Icon ? <Icon className="size-3.5" /> : <span className="w-3.5" />}
        <span className="flex-1 truncate">{entry.label}</span>
        {entry.shortcut && <Shortcut>{entry.shortcut}</Shortcut>}
      </Item>
    );
  });
}

const contextParts: Parts = {
  Item: ContextMenuItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
};
const dropdownParts: Parts = {
  Item: DropdownMenuItem,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
};

interface RowContextMenuProps {
  /** Built when the menu opens, so it reflects current state. */
  entries: () => MenuEntry[];
  /** The element right-clicked; must accept a ref and forward props. */
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
}

/** Right-click menu for a row, tab or any element. */
export function RowContextMenu({ entries, children, onOpenChange }: RowContextMenuProps) {
  // Content mounts only while open, so entries() runs per opening, not per render.
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    >
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {open && (
        <ContextMenuContent>
          <Entries entries={entries()} parts={contextParts} />
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}

interface ActionMenuButtonProps {
  entries: () => MenuEntry[];
  /** Accessible name, e.g. "Actions for Local dev". */
  label: string;
  className?: string;
  /** Replaces the default "…" icon trigger. */
  trigger?: ReactNode;
  align?: "start" | "end";
}

/** The "…" button that opens the same actions as a row's right-click menu. */
export function ActionMenuButton({ entries, label, className, trigger, align = "start" }: ActionMenuButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            title={label}
            data-no-drag=""
            className={cn(className)}
          >
            <MoreHorizontal />
          </Button>
        )}
      </DropdownMenuTrigger>
      {open && (
        <DropdownMenuContent align={align}>
          <Entries entries={entries()} parts={dropdownParts} />
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
