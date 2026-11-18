import { Fragment, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConnectionColor } from "@/lib/connectionColor";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useConsoleStore } from "../../store/consoleStore";
import { databaseKey } from "../../store/explorerStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { Tab, TabConnection } from "../../store/sessionsStore";
import type { DatabaseInfo } from "../../types/pg";

const PILL =
  "inline-flex h-[26px] min-w-0 shrink items-center gap-1.5 rounded-md bg-fg/6 px-2 text-sm text-fg-2";

interface ConnectedTarget {
  connection: TabConnection;
  databases: DatabaseInfo[];
}

/** Every connected server with its databases, in the sidebar's order. */
function useConnectedTargets(): ConnectedTarget[] {
  const profiles = useConnectionsStore((s) => s.profiles);
  const sessions = useConnectionsStore((s) => s.sessions);
  return useMemo(
    () =>
      profiles.flatMap((p) => {
        const live = sessions[p.id];
        return live?.databases.length
          ? [{ connection: { id: p.id, name: p.name, summary: p.summary }, databases: live.databases }]
          : [];
      }),
    [profiles, sessions],
  );
}

/**
 * Where Run goes: the connection and the database. A console tab's pill
 * also switches its database (a connection reaches one at a time) - or,
 * with more than one server connected, moves it to another one.
 */
export function ConsoleTargetPill({ tab }: { tab: Tab }) {
  const color = useConnectionColor(tab.connection.id);
  const targets = useConnectedTargets();
  const running = useConsoleStore((s) => s.consoles[tab.id]?.running ?? false);
  const switchDatabase = useSessionsStore((s) => s.switchConsoleDatabase);
  const target = tab.database;
  const title = `Runs against ${target} on ${tab.connection.name} (${tab.connection.summary})`;

  const content = (
    <>
      <ConnectionChip name={tab.connection.name} color={color} size="sm" />
      <span className="max-w-48 shrink-0 truncate font-data font-medium text-fg">{target}</span>
      {/* A table tab's breadcrumb already names the connection. */}
      {tab.kind === "console" && <span className="truncate @max-[1000px]:hidden">on {tab.connection.name}</span>}
    </>
  );

  // a run in flight is bound to the connection it started on
  if (tab.kind !== "console" || targets.length === 0 || running) {
    return (
      <span className={PILL} title={title}>
        {content}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`${PILL} hover:bg-fg/10`}
          title={`${title}. Click to switch ${targets.length > 1 ? "connections or databases" : "databases"}`}
        >
          {content}
          <ChevronDown className="size-3 shrink-0 text-fg-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel>Run against</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={databaseKey(tab.connection.id, tab.database)}>
          {targets.map((target, i) => (
            <Fragment key={target.connection.id}>
              {targets.length > 1 && (
                <>
                  {i > 0 && <DropdownMenuSeparator />}
                  <TargetHeading connection={target.connection} />
                </>
              )}
              {target.databases.map((db) => (
                <DropdownMenuRadioItem
                  key={db.name}
                  value={databaseKey(target.connection.id, db.name)}
                  className="font-data"
                  onSelect={() => switchDatabase(tab.id, db.name, target.connection)}
                >
                  {db.name}
                </DropdownMenuRadioItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TargetHeading({ connection }: { connection: TabConnection }) {
  const color = useConnectionColor(connection.id);
  return (
    <DropdownMenuLabel className="flex items-center gap-1.5" title={connection.summary}>
      <ConnectionChip name={connection.name} color={color} size="sm" />
      <span className="truncate">{connection.name}</span>
    </DropdownMenuLabel>
  );
}
