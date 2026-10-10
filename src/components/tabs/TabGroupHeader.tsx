import type { CSSProperties } from "react";
import { Layers } from "lucide-react";
import { RowContextMenu } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { useConnectionColor } from "@/lib/connectionColor";
import { cn } from "@/lib/utils";
import type { StripGroup } from "../../lib/tabGroups";
import { useTabGroupsStore } from "../../store/tabGroupsStore";
import { PaneNumber } from "./PaneNumber";
import { useTabDragStore } from "./useTabDrag";

type HeaderGroup = Exclude<StripGroup, { kind: "ungrouped" }>;

interface TabGroupHeaderProps {
  group: HeaderGroup;
  collapsed: boolean;
  /** Panes showing tabs of this group, listed on the chip while it's collapsed. */
  panes: number[];
  focusedPane: number;
  entries: () => MenuEntry[];
}

/**
 * A group's chip at the head of its tabs: a connection's carries its color
 * and initials, a group of the user's a neutral stack icon (connection
 * colors only ever name a connection). Click collapses or expands it; a tab
 * dropped on it joins the group.
 */
export function TabGroupHeader({ group, collapsed, panes, focusedPane, entries }: TabGroupHeaderProps) {
  const renaming = useTabGroupsStore((s) => s.renaming === group.id);
  const toggleCollapsed = useTabGroupsStore((s) => s.toggleCollapsed);
  const renameGroup = useTabGroupsStore((s) => s.renameGroup);
  const startRename = useTabGroupsStore((s) => s.startRename);
  const dropping = useTabDragStore((s) => s.target?.kind === "group" && s.target.groupId === group.id);
  const color = useConnectionColor(group.kind === "connection" ? group.connection.id : "");
  const tint = group.kind === "connection" ? color : "var(--color-fg-3)";
  const count = group.tabs.length;

  if (renaming && group.kind === "manual") {
    return (
      <input
        autoFocus
        defaultValue={group.name}
        aria-label="Group name"
        spellCheck={false}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") renameGroup(group.id, e.currentTarget.value);
          else if (e.key === "Escape") startRename(null);
          else return;
          e.preventDefault();
        }}
        onBlur={(e) => renameGroup(group.id, e.currentTarget.value)}
        className="mx-1.5 h-6 w-[168px] self-center rounded-md border border-accent bg-field px-2 text-sm font-medium text-fg outline-none ring-2 ring-accent/30"
      />
    );
  }

  return (
    <RowContextMenu entries={entries}>
      <button
        type="button"
        data-drop-group={group.id}
        data-drop-manual={group.kind === "manual" ? "" : undefined}
        aria-expanded={!collapsed}
        title={`${group.name} · ${count} tab${count === 1 ? "" : "s"}\nClick to ${collapsed ? "expand" : "collapse"}, right-click for more`}
        onClick={() => toggleCollapsed(group.id)}
        style={{ "--c": tint } as CSSProperties}
        className={cn(
          "my-auto mr-0.5 ml-1.5 inline-flex h-6 max-w-[210px] shrink-0 items-center gap-1.5 rounded-md pr-2 text-sm font-medium whitespace-nowrap text-fg transition-[background-color,box-shadow] duration-150",
          "bg-[color-mix(in_srgb,var(--c)_15%,transparent)] hover:bg-[color-mix(in_srgb,var(--c)_24%,transparent)]",
          group.kind === "connection" ? "pl-1" : "pl-1.5",
          dropping && "ring-2 ring-accent",
        )}
      >
        {group.kind === "connection" ? (
          <ConnectionChip name={group.name} color={color} size="sm" />
        ) : (
          <Layers className="size-3.5 shrink-0 text-fg-2" aria-hidden />
        )}
        <span className="min-w-0 truncate">{group.name}</span>
        {collapsed && (
          <>
            <span className="h-4 min-w-[18px] rounded-full bg-[color-mix(in_srgb,var(--c)_30%,transparent)] px-1.5 text-center text-2xs leading-4 font-semibold tabular-nums">
              {count}
            </span>
            {panes.map((p) => (
              <PaneNumber key={p} pane={p} focused={p === focusedPane} />
            ))}
          </>
        )}
      </button>
    </RowContextMenu>
  );
}
