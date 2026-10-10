import { ChevronDown } from "lucide-react";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConnectionColor } from "@/lib/connectionColor";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { Tab } from "../../store/sessionsStore";

const PILL =
  "inline-flex h-[26px] min-w-0 shrink items-center gap-1.5 rounded-md bg-fg/6 px-2 text-sm text-fg-2";

/**
 * Where Run goes: the connection and the database. A console tab's pill
 * also switches its database (a connection reaches one at a time).
 */
export function ConsoleTargetPill({ tab }: { tab: Tab }) {
  const color = useConnectionColor(tab.connection.id);
  const databases = useConnectionsStore((s) => s.sessions[tab.connection.id]?.databases);
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

  if (tab.kind !== "console" || !databases?.length) {
    return (
      <span className={PILL} title={title}>
        {content}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={`${PILL} hover:bg-fg/10`} title={`${title}. Click to switch databases`}>
          {content}
          <ChevronDown className="size-3 shrink-0 text-fg-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        <DropdownMenuLabel>Run against</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={tab.database} onValueChange={(db) => switchDatabase(tab.id, db)}>
          {databases.map((db) => (
            <DropdownMenuRadioItem key={db.name} value={db.name} className="font-data">
              {db.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
