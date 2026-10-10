import { useMemo } from "react";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { sessionIdFor } from "../../store/connectionsStore";
import { topMatches } from "../../lib/paletteMatch";
import { useSessionsStore } from "../../store/sessionsStore";
import { HighlightMatch } from "./HighlightMatch";
import { usePaletteTables } from "./usePaletteCollections";
import type { PaletteTable } from "./usePaletteCollections";

/** Tables rendered at most; the search itself covers all of them. */
const SHOWN = 50;

interface PaletteTablesProps {
  search: string;
  /** Closes the palette, then runs the choice. */
  run: (action: () => void) => void;
}

function open(item: PaletteTable) {
  const sessionId = sessionIdFor(item.connection.id);
  if (!sessionId) return;
  void useSessionsStore.getState().openTable(sessionId, item.connection, item.database, item.schema, item.table, item.kind);
}

/** The palette's tables and views, from every connected server: the best matches. */
export function PaletteCollections({ search, run }: PaletteTablesProps) {
  const tables = usePaletteTables();
  const { items, total } = useMemo(() => topMatches(tables, search, SHOWN), [tables, search]);
  if (items.length === 0) return null;
  return (
    <CommandGroup
      heading={
        <>
          Tables
          {total > items.length && (
            <span className="float-right font-normal">
              {items.length} of {total.toLocaleString("en-US")}
              {search.trim() ? " · keep typing to narrow" : " · type to search"}
            </span>
          )}
        </>
      }
    >
      {items.map((item) => {
        const label = item.schema === "public" ? item.table : `${item.schema}.${item.table}`;
        return (
          <CommandItem
            key={item.key}
            value={`table:${item.key}`}
            keywords={[label, item.database, item.connection.name]}
            onSelect={() => run(() => open(item))}
          >
            <ConnectionChip name={item.connection.name} color={item.color} />
            <span className="min-w-0 truncate font-data">
              <HighlightMatch text={label} query={search} />
            </span>
            {item.kind === "v" && <span className="shrink-0 text-xs text-fg-3">view</span>}
            <span className="ml-auto shrink-0 pl-3 text-sm text-fg-3">
              {item.database} · {item.connection.name}
            </span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
