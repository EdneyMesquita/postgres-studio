import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Check, ChevronDown, Layers, Maximize2, Minimize2, PanelRight, Pencil, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { ActionMenuButton } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { Button } from "@/components/ui/button";
import { useConnectionColor } from "@/lib/connectionColor";
import { isSplit, paneOf } from "../../lib/editorLayout";
import { stripGroups, type StripGroup } from "../../lib/tabGroups";
import { useEditorLayoutStore } from "../../store/editorLayoutStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { Tab } from "../../store/sessionsStore";
import { useTabGroupsStore } from "../../store/tabGroupsStore";
import { EditorTab } from "./EditorTab";
import { LayoutPicker } from "./LayoutPicker";
import { TabGroupHeader } from "./TabGroupHeader";
import { tabIcon, tabName } from "./tabName";

/**
 * Open collections and consoles, across every database of every connection,
 * gathered into groups: the user's own first, then one per connection.
 */
export function CollectionTabs() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeTabId = useSessionsStore((s) => s.activeTabId);
  const closeTab = useSessionsStore((s) => s.closeTab);
  const closeOtherTabs = useSessionsStore((s) => s.closeOtherTabs);
  const closeAllTabs = useSessionsStore((s) => s.closeAllTabs);
  const groupBy = useTabGroupsStore((s) => s.groupBy);
  const manual = useTabGroupsStore((s) => s.groups);
  const membership = useTabGroupsStore((s) => s.membership);
  const collapsed = useTabGroupsStore((s) => s.collapsed);
  const renaming = useTabGroupsStore((s) => s.renaming);
  const layout = useEditorLayoutStore((s) => s.layout);
  const panes = useEditorLayoutStore((s) => s.panes);
  const focused = useEditorLayoutStore((s) => s.focused);
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  const groups = useMemo(
    () => stripGroups(tabs, groupBy, manual, membership, renaming),
    [tabs, groupBy, manual, membership, renaming],
  );
  const split = isSplit({ layout, panes, focused, maximized: null });
  const pane = (id: string) => paneOf({ layout, panes, focused, maximized: null }, id);
  // In a split the selected tab is the focused pane's, which may be empty.
  const selected = split ? panes[focused] : activeTabId;

  // Tabs past the strip's edge are listed in a menu at its end.
  const measure = useCallback(() => {
    if (strip) setOverflowing(strip.scrollWidth > strip.clientWidth + 1);
  }, [strip]);
  useEffect(() => {
    if (!strip) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [strip, measure, groups, collapsed]);
  // The active tab scrolls into view, e.g. one opened from the Assistant.
  useEffect(() => {
    strip?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [strip, activeTabId]);

  if (tabs.length === 0) return null;

  const tabMenu = (tab: Tab) => (): MenuEntry[] => {
    const layoutStore = useEditorLayoutStore.getState();
    const groupsStore = useTabGroupsStore.getState();
    const inGroup = groupsStore.membership[tab.id];
    const entries: MenuEntry[] = [
      { label: "Close tab", icon: X, onSelect: () => closeTab(tab.id) },
      { label: "Close other tabs", onSelect: () => closeOtherTabs(tab.id), disabled: tabs.length < 2 },
      { label: "Close all tabs", onSelect: closeAllTabs },
      { separator: true },
      {
        label: "Open to the side",
        icon: PanelRight,
        shortcut: "Ctrl \\",
        onSelect: () => {
          if (!layoutStore.openToSide(tab.id)) toast("All four panes are in use", { description: "Close a pane, or drop the tab onto one to replace it." });
        },
      },
    ];
    if (split) {
      panes.forEach((p, i) => {
        if (p !== tab.id) entries.push({ label: `Open in pane ${i + 1}${p ? "" : " (empty)"}`, onSelect: () => layoutStore.openInPane(tab.id, i) });
      });
    }
    entries.push({ separator: true });
    for (const g of groupsStore.groups) {
      if (g.id !== inGroup) entries.push({ label: `Add to “${g.name}”`, icon: Layers, onSelect: () => groupsStore.moveToGroup(tab.id, g.id) });
    }
    entries.push({ label: "Add to a new group", icon: Plus, onSelect: () => groupsStore.createGroup(tab.id) });
    if (inGroup) entries.push({ label: "Remove from group", onSelect: () => groupsStore.moveToGroup(tab.id, null) });
    return entries;
  };

  const groupMenu = (group: Exclude<StripGroup, { kind: "ungrouped" }>) => (): MenuEntry[] => {
    const groupsStore = useTabGroupsStore.getState();
    const isCollapsed = Boolean(groupsStore.collapsed[group.id]);
    const n = group.tabs.length;
    const entries: MenuEntry[] = [
      { heading: group.kind === "connection" ? `${group.name} · ${n} tab${n === 1 ? "" : "s"}` : `${group.name} · your group` },
      {
        label: isCollapsed ? "Expand group" : "Collapse group",
        icon: isCollapsed ? Maximize2 : Minimize2,
        onSelect: () => groupsStore.toggleCollapsed(group.id),
      },
      {
        label: n > 4 ? "Open the first 4 side by side" : "Open side by side",
        icon: PanelRight,
        disabled: n < 2,
        onSelect: () => openSideBySide(group),
      },
    ];
    if (group.kind === "manual") {
      entries.push(
        { label: "Rename group", icon: Pencil, onSelect: () => groupsStore.startRename(group.id) },
        { label: "Ungroup", icon: Layers, onSelect: () => groupsStore.ungroup(group.id) },
      );
    }
    entries.push(
      { separator: true },
      { label: `Close ${n} tab${n === 1 ? "" : "s"}`, icon: X, danger: true, onSelect: () => group.tabs.forEach((t) => closeTab(t.id)) },
    );
    return entries;
  };

  const groupsMenu = (): MenuEntry[] => {
    const groupsStore = useTabGroupsStore.getState();
    const ids = groups.filter((g) => g.kind !== "ungrouped").map((g) => g.id);
    return [
      { heading: "Tab groups" },
      { label: "Group by connection", icon: groupBy === "connection" ? Check : undefined, onSelect: () => groupsStore.setGroupBy("connection") },
      { label: "Don't group automatically", icon: groupBy === "none" ? Check : undefined, onSelect: () => groupsStore.setGroupBy("none") },
      { separator: true },
      { label: "Collapse all groups", icon: Minimize2, disabled: ids.length === 0, onSelect: () => groupsStore.setAllCollapsed(ids, true) },
      { label: "Expand all groups", icon: Maximize2, disabled: ids.length === 0, onSelect: () => groupsStore.setAllCollapsed(ids, false) },
    ];
  };

  return (
    <div className="flex h-9 shrink-0 border-b border-line bg-editor">
      <div
        ref={setStrip}
        role="tablist"
        aria-label="Open tabs"
        // No visible scrollbar - it would squeeze the labels - so a plain mouse
        // wheel scrolls the strip sideways instead, like editor tab bars.
        className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto scrollbar-none"
        onWheel={(e) => {
          if (e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {groups.map((group) => {
          const renderTab = (t: Tab, bare: boolean) => {
            const p = pane(t.id);
            return (
              <EditorTab
                key={t.id}
                tab={t}
                active={t.id === selected}
                entries={tabMenu(t)}
                bare={bare}
                pane={p >= 0 ? p : null}
                paneFocused={p === focused}
              />
            );
          };
          if (group.kind === "ungrouped") return group.tabs.map((t) => renderTab(t, false));
          const isCollapsed = Boolean(collapsed[group.id]);
          const groupPanes = group.tabs.map((t) => pane(t.id)).filter((p) => p >= 0).sort();
          return (
            <GroupRun key={group.id} group={group} collapsed={isCollapsed}>
              <TabGroupHeader
                group={group}
                collapsed={isCollapsed}
                panes={groupPanes}
                focusedPane={focused}
                entries={groupMenu(group)}
              />
              {!isCollapsed && group.tabs.map((t) => renderTab(t, group.kind === "connection"))}
            </GroupRun>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 border-l border-line-soft px-1">
        <ActionMenuButton
          label="Tab groups"
          align="end"
          entries={groupsMenu}
          trigger={
            <Button variant="ghost" size="icon" title="Tab groups" aria-label="Tab groups">
              <Layers className="size-4" />
            </Button>
          }
        />
        <LayoutPicker />
      </div>
      {overflowing && (
        <ActionMenuButton
          label="All open tabs"
          align="end"
          // Listed by group, so the tabs of a collapsed group are one step away.
          entries={() =>
            groups.flatMap((g): MenuEntry[] => [
              { heading: g.kind === "ungrouped" ? "Open tabs" : `${g.name}${collapsed[g.id] ? " · collapsed" : ""}` },
              ...g.tabs.map((t) => ({
                label: g.kind === "connection" ? tabName(t) : `${tabName(t)} · ${t.connection.name}`,
                icon: t.id === selected ? Check : tabIcon(t),
                onSelect: () => useEditorLayoutStore.getState().showTab(t.id),
              })),
            ])
          }
          trigger={
            <Button variant="ghost" size="icon" title="All open tabs" aria-label="All open tabs" className="h-full w-8 rounded-none border-l border-line-soft">
              <ChevronDown className="size-3.5" />
            </Button>
          }
        />
      )}
    </div>
  );
}

/** Opens a group's first four tabs in as many panes. */
function openSideBySide(group: StripGroup) {
  const ids = group.tabs.slice(0, 4).map((t) => t.id);
  if (ids.length < 2) return;
  const layout = useEditorLayoutStore.getState();
  layout.setLayout(ids.length === 2 ? "cols2" : ids.length === 3 ? "cols3" : "grid");
  ids.forEach((id, i) => useEditorLayoutStore.getState().openInPane(id, i));
  useEditorLayoutStore.getState().focusPane(0);
  useTabGroupsStore.getState().setAllCollapsed([group.id], false);
  if (group.tabs.length > 4) {
    toast(`Opened the first 4 of ${group.tabs.length} tabs`, { description: "Four panes is the most the editor splits into." });
  }
}

/** A group's header and tabs, underlined in the group's tint. */
function GroupRun({
  group,
  collapsed,
  children,
}: {
  group: Exclude<StripGroup, { kind: "ungrouped" }>;
  collapsed: boolean;
  children: ReactNode;
}) {
  const color = useConnectionColor(group.kind === "connection" ? group.connection.id : "");
  const tint = group.kind === "connection" ? color : "var(--color-fg-3)";
  return (
    <div role="group" aria-label={group.name} className="relative flex shrink-0 items-stretch" style={{ "--c": tint } as CSSProperties}>
      {/* First, so the active tab's own underline paints over it. */}
      {!collapsed && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-1 bottom-0 left-2.5 h-0.5 rounded-t-[2px] bg-[color-mix(in_srgb,var(--c)_42%,transparent)]"
        />
      )}
      {children}
    </div>
  );
}
