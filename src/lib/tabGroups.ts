/**
 * How the tab strip groups tabs: groups the user made come first, then the
 * rest, one group per connection (or a plain run when grouping is off).
 * Pure; the store keeps the groups and which tab is in which.
 */
import type { Tab, TabConnection } from "../store/sessionsStore";

export type GroupBy = "connection" | "none";

/** A group the user made. It can hold tabs of several connections. */
export interface ManualGroup {
  id: string;
  name: string;
}

export type StripGroup =
  | { kind: "manual"; id: string; name: string; tabs: Tab[] }
  | { kind: "connection"; id: string; name: string; connection: TabConnection; tabs: Tab[] }
  | { kind: "ungrouped"; id: typeof UNGROUPED; tabs: Tab[] };

export const UNGROUPED = "ungrouped";

/** A connection group's id; manual group ids are UUIDs, so they never collide. */
export const connectionGroupId = (connectionId: string) => `connection:${connectionId}`;

/**
 * The strip's groups in order. Manual groups keep the order they were made
 * in and show even when empty only while being named (`keep`); connection
 * groups follow the order of their first tab.
 */
export function stripGroups(
  tabs: Tab[],
  groupBy: GroupBy,
  groups: ManualGroup[],
  membership: Record<string, string>,
  keep: string | null = null,
): StripGroup[] {
  const out: StripGroup[] = [];
  const known = new Set(groups.map((g) => g.id));
  for (const g of groups) {
    const inGroup = tabs.filter((t) => membership[t.id] === g.id);
    if (inGroup.length > 0 || g.id === keep) out.push({ kind: "manual", id: g.id, name: g.name, tabs: inGroup });
  }
  const rest = tabs.filter((t) => !known.has(membership[t.id] ?? ""));
  if (rest.length === 0) return out;
  if (groupBy === "none") {
    out.push({ kind: "ungrouped", id: UNGROUPED, tabs: rest });
    return out;
  }
  const byConnection = new Map<string, Tab[]>();
  for (const t of rest) {
    const list = byConnection.get(t.connection.id);
    if (list) list.push(t);
    else byConnection.set(t.connection.id, [t]);
  }
  for (const list of byConnection.values()) {
    const connection = list[0].connection;
    out.push({
      kind: "connection",
      id: connectionGroupId(connection.id),
      name: connection.name,
      connection,
      tabs: list,
    });
  }
  return out;
}

/** Drops closed tabs from the membership, and groups left with no tabs. */
export function pruneGroups(
  groups: ManualGroup[],
  membership: Record<string, string>,
  open: ReadonlySet<string>,
  keep: string | null = null,
): { groups: ManualGroup[]; membership: Record<string, string> } {
  const kept = Object.fromEntries(Object.entries(membership).filter(([tabId]) => open.has(tabId)));
  const used = new Set(Object.values(kept));
  return { groups: groups.filter((g) => used.has(g.id) || g.id === keep), membership: kept };
}
