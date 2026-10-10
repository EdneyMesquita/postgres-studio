import { connectionColor } from "../../lib/connectionColor";
import { useConnectionsStore } from "../../store/connectionsStore";
import type { ActiveSession } from "../../store/connectionsStore";
import { selectActiveTab, useSessionsStore } from "../../store/sessionsStore";
import type { Tab } from "../../store/sessionsStore";

export interface ActiveConnection {
  tab: Tab;
  /** The connection's identity color. */
  color: string;
  session: ActiveSession | undefined;
}

/**
 * The connection the active tab runs against - the one the toolbar, the
 * breadcrumb and the status bar speak for. Null without an active tab.
 */
export function useActiveConnection(): ActiveConnection | null {
  const tab = useSessionsStore(selectActiveTab);
  const connectionId = tab?.connection.id ?? "";
  const color = useConnectionsStore(
    (s) => s.profiles.find((p) => p.id === connectionId)?.color,
  );
  const session = useConnectionsStore((s) => s.sessions[connectionId]);
  if (!tab) return null;
  return { tab, color: connectionColor(tab.connection.id, color), session };
}

/** How many servers are connected right now. */
export function useConnectedCount(): number {
  return useConnectionsStore((s) => Object.keys(s.sessions).length);
}
