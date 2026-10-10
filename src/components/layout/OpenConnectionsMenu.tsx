import { Check, Unplug } from "lucide-react";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { connectionColor } from "../../lib/connectionColor";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSessionsStore } from "../../store/sessionsStore";
import { useUiStore } from "../../store/uiStore";
import { lastTabOf } from "./lastTabs";

/** Brings a connection forward: its last tab, or its tree when none is open. */
function jumpTo(connectionId: string) {
  const tabId = lastTabOf(connectionId);
  if (tabId) useSessionsStore.getState().activateTab(tabId);
  else useUiStore.getState().setSidePanel("explorer");
}

/**
 * A dropdown's list of open connections: each jumps to its tabs and has
 * its own disconnect button (or Delete while highlighted), then
 * "Disconnect all". Nothing when no connection is open.
 */
export function OpenConnectionsItems({ activeId }: { activeId: string | null }) {
  const sessions = useConnectionsStore((s) => s.sessions);
  const profiles = useConnectionsStore((s) => s.profiles);
  const disconnect = useConnectionsStore((s) => s.disconnect);
  const disconnectAll = useConnectionsStore((s) => s.disconnectAll);
  const open = profiles.filter((p) => sessions[p.id]);
  if (open.length === 0) return null;

  return (
    <>
      <DropdownMenuLabel>Open connections</DropdownMenuLabel>
      {open.map((p) => (
        <DropdownMenuItem
          key={p.id}
          className="pr-1"
          onSelect={() => jumpTo(p.id)}
          onKeyDown={(e) => {
            if (e.key === "Delete") void disconnect(p.id);
          }}
        >
          <ConnectionChip name={p.name} color={connectionColor(p.id, p.color)} />
          <span className="truncate">{p.name}</span>
          <span className="flex-1" />
          {activeId === p.id && <Check />}
          <button
            type="button"
            className="grid size-5 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-fg/10 hover:text-fg"
            title={`Disconnect ${p.name} (Delete)`}
            aria-label={`Disconnect ${p.name}`}
            // the row behind it jumps to the connection; this only disconnects
            onClick={(e) => {
              e.stopPropagation();
              void disconnect(p.id);
            }}
          >
            <Unplug className="size-3.5 text-current" />
          </button>
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem onSelect={() => void disconnectAll()}>
        <Unplug />
        {open.length === 1 ? `Disconnect ${open[0].name}` : `Disconnect all ${open.length}`}
      </DropdownMenuItem>
    </>
  );
}
