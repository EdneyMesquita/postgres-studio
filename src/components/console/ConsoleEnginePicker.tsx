import { useEffect } from "react";
import { Check, ChevronDown, Database, Settings, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { psqlFound, usePsqlStore } from "../../store/psqlStore";
import { useSettingsStore, useTabEngine, type ConsoleEngine } from "../../store/settingsStore";
import { useUiStore } from "../../store/uiStore";

/** Which engine runs this console, and a menu to switch it for this console alone. */
export function ConsoleEnginePicker({ tabId }: { tabId: string }) {
  const engine = useTabEngine(tabId);
  const setTabEngine = useSettingsStore((s) => s.setTabEngine);
  const info = usePsqlStore((s) => s.info);
  const detect = usePsqlStore((s) => s.detect);
  const found = psqlFound(info);
  const psqlName = `psql${info?.version ? ` ${info.version}` : ""}`;

  useEffect(() => {
    if (usePsqlStore.getState().info === null) void detect();
  }, [detect]);

  const pick = (e: ConsoleEngine) => setTabEngine(tabId, e);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" title="Engine for this console" className="@max-[700px]:px-1.5">
          {engine === "psql" ? <SquareTerminal /> : <Database />}
          <span className="@max-[700px]:hidden">{engine === "psql" ? psqlName : "Built-in"}</span>
          <ChevronDown className="size-3 text-fg-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Run this console with</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => pick("builtin")}>
          {engine === "builtin" ? <Check /> : <span className="size-4" />}
          Built-in
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!found} onSelect={() => pick("psql")}>
          {engine === "psql" ? <Check /> : <span className="size-4" />}
          {found ? psqlName : "psql (not found)"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => useUiStore.getState().setSettingsSection("console")}>
          <Settings />
          {found ? "Console settings…" : "Get psql…"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
