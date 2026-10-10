import { create } from "zustand";
import { persist } from "zustand/middleware";
import { pruneGroups, stripGroups, type GroupBy, type ManualGroup } from "../lib/tabGroups";
import { isSplit } from "../lib/editorLayout";
import { useEditorLayoutStore } from "./editorLayoutStore";
import { useSessionsStore } from "./sessionsStore";

interface TabGroupsState {
  /** Whether tabs outside a group of the user's gather by connection. */
  groupBy: GroupBy;
  groups: ManualGroup[];
  /** Tab id to the manual group it's in. */
  membership: Record<string, string>;
  /** Collapsed groups, manual or connection. */
  collapsed: Record<string, true>;
  /** The group whose name is being edited in place. */
  renaming: string | null;

  setGroupBy: (groupBy: GroupBy) => void;
  toggleCollapsed: (groupId: string) => void;
  setAllCollapsed: (groupIds: string[], collapsed: boolean) => void;
  /** Makes a group holding the tab and starts naming it; returns its id. */
  createGroup: (tabId: string) => string;
  startRename: (groupId: string | null) => void;
  renameGroup: (groupId: string, name: string) => void;
  /** Puts the tab in a manual group, or takes it out with null. */
  moveToGroup: (tabId: string, groupId: string | null) => void;
  ungroup: (groupId: string) => void;
}

/** The strip as it is now: the groups with their tabs. */
export function currentStripGroups() {
  const { tabs } = useSessionsStore.getState();
  const { groupBy, groups, membership, renaming } = useTabGroupsStore.getState();
  return stripGroups(tabs, groupBy, groups, membership, renaming);
}

export const useTabGroupsStore = create<TabGroupsState>()(
  persist(
    (set, get) => ({
      groupBy: "connection",
      groups: [],
      membership: {},
      collapsed: {},
      renaming: null,

      setGroupBy: (groupBy) => set({ groupBy }),

      toggleCollapsed: (groupId) => {
        const collapsing = !get().collapsed[groupId];
        set((s) => ({ collapsed: toggled(s.collapsed, groupId, collapsing) }));
        // In a split the panes show the tabs; a collapsed chip names their panes.
        if (!collapsing || isSplit(useEditorLayoutStore.getState())) return;
        // Like a browser: collapsing the group of the active tab moves to
        // the first tab still in view, so the active tab is never hidden.
        const sessions = useSessionsStore.getState();
        const groups = currentStripGroups();
        if (!groups.find((g) => g.id === groupId)?.tabs.some((t) => t.id === sessions.activeTabId)) return;
        const visible = groups.filter((g) => !get().collapsed[g.id]).flatMap((g) => g.tabs);
        if (visible[0]) sessions.activateTab(visible[0].id);
      },

      setAllCollapsed: (groupIds, collapsed) =>
        set((s) => ({ collapsed: groupIds.reduce((acc, id) => toggled(acc, id, collapsed), s.collapsed) })),

      createGroup: (tabId) => {
        const id = crypto.randomUUID();
        set((s) => ({
          groups: [...s.groups, { id, name: `Group ${s.groups.length + 1}` }],
          membership: { ...s.membership, [tabId]: id },
          renaming: id,
        }));
        return id;
      },

      startRename: (groupId) => set({ renaming: groupId }),

      renameGroup: (groupId, name) => {
        const trimmed = name.trim();
        set((s) => ({
          renaming: null,
          groups: trimmed ? s.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)) : s.groups,
        }));
      },

      moveToGroup: (tabId, groupId) =>
        set((s) => {
          const membership = { ...s.membership };
          if (groupId) membership[tabId] = groupId;
          else delete membership[tabId];
          const open = new Set(useSessionsStore.getState().tabs.map((t) => t.id));
          return {
            ...pruneGroups(s.groups, membership, open, s.renaming),
            collapsed: groupId ? toggled(s.collapsed, groupId, false) : s.collapsed,
          };
        }),

      ungroup: (groupId) =>
        set((s) => ({
          groups: s.groups.filter((g) => g.id !== groupId),
          membership: Object.fromEntries(Object.entries(s.membership).filter(([, g]) => g !== groupId)),
        })),
    }),
    {
      name: "postgres-studio-tab-groups",
      // Groups hold tabs, which don't outlive the app; the preference does.
      partialize: (s) => ({ groupBy: s.groupBy }),
    },
  ),
);

function toggled(collapsed: Record<string, true>, groupId: string, on: boolean): Record<string, true> {
  if (on === Boolean(collapsed[groupId])) return collapsed;
  const next = { ...collapsed };
  if (on) next[groupId] = true;
  else delete next[groupId];
  return next;
}

// Closed tabs leave their groups, and with one pane a tab activated from
// elsewhere (the sidebar, Ctrl+K) opens its group if it was collapsed.
useSessionsStore.subscribe((state, prev) => {
  const store = useTabGroupsStore.getState();
  if (state.tabs !== prev.tabs) {
    const open = new Set(state.tabs.map((t) => t.id));
    const pruned = pruneGroups(store.groups, store.membership, open, store.renaming);
    if (pruned.groups.length !== store.groups.length || Object.keys(pruned.membership).length !== Object.keys(store.membership).length) {
      useTabGroupsStore.setState(pruned);
    }
  }
  if (state.activeTabId !== prev.activeTabId && state.activeTabId && !isSplit(useEditorLayoutStore.getState())) {
    const group = currentStripGroups().find((g) => g.tabs.some((t) => t.id === state.activeTabId));
    if (group && store.collapsed[group.id]) {
      useTabGroupsStore.setState({ collapsed: toggled(store.collapsed, group.id, false) });
    }
  }
});
