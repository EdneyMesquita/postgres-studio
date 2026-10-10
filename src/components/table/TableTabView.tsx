import { memo } from "react";
import { Download, ListTree, RefreshCw, Rows3, SquareTerminal } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api } from "../../lib/tauri";
import { ident } from "../../lib/editSql";
import { formatInt } from "@/lib/format";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { TableTab } from "../../store/sessionsStore";
import { useUiStore } from "../../store/uiStore";
import type { MainTab } from "../../store/uiStore";
import { useAssistantStore } from "../../store/assistantStore";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { SegmentOption } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import { ScriptConsole } from "../console/ScriptConsole";
import { InlineAskStrip } from "../assistant/InlineAskStrip";
import { useAssistantFlash } from "../assistant/useAssistantFlash";
import { DataView } from "./DataView";
import { StructureView } from "./StructureView";

const views: SegmentOption<MainTab>[] = [
  { value: "data", label: "Data", icon: <Rows3 /> },
  { value: "structure", label: "Structure", icon: <ListTree /> },
  { value: "sql", label: "SQL", icon: <SquareTerminal /> },
];

/** The SELECT behind the tab's current filter and order, for exports. */
function querySql(tab: TableTab, withLimit: boolean): string {
  let sql = `SELECT * FROM ${ident(tab.schema)}.${ident(tab.table)}`;
  if (tab.whereText.trim()) sql += ` WHERE (${tab.whereText.trim()}\n)`;
  if (tab.orderByText.trim()) sql += ` ORDER BY ${tab.orderByText.trim()}\n`;
  if (withLimit) sql += ` LIMIT ${tab.limit} OFFSET ${tab.offset}`;
  return sql;
}

async function exportTable(tab: TableTab, sessionId: string, format: "csv" | "json", all: boolean) {
  const path = await save({
    defaultPath: `${tab.table}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (!path) return;
  const id = toast.loading(`Exporting ${tab.table}…`);
  try {
    const summary = await api.exportQuery(sessionId, tab.database, querySql(tab, !all), format, path, crypto.randomUUID());
    toast.success(`Exported ${formatInt(summary.rowsWritten)} rows`, { id, description: path });
  } catch (e) {
    toast.error("Export failed", { id, description: String(e) });
  }
}

/**
 * Everything under a table tab: Data, Structure and SQL in the same tab.
 * Memoised: every open tab stays mounted, and typing in one tab must not
 * re-render the others.
 */
export const TableTabView = memo(function TableTabView({ tab, active, shown }: { tab: TableTab; active: boolean; shown: boolean }) {
  const session = useConnectionsStore((s) => s.sessions[tab.connection.id]);
  const view = useUiStore((s) => s.mainTabs[tab.id] ?? "data");
  const setMainTab = useUiStore((s) => s.setMainTab);
  const ask = useAssistantStore((s) => (s.inline[tab.id]?.kind === "filter" ? s.inline[tab.id] : undefined));
  const askInline = useAssistantStore((s) => s.askInline);
  const flash = useAssistantFlash(tab.id);

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <div className="@container flex h-9 flex-none items-center gap-2 border-b border-line pr-2 pl-2.5">
        <SegmentedControl aria-label="View" value={view} onChange={(v) => setMainTab(tab.id, v)} options={views} />
        <span className="flex-1" />
        {view !== "sql" && session && (
          <>
            <Button
              variant="ghost"
              title="Reload the rows and the structure"
              onClick={() => {
                void useSessionsStore.getState().loadInfo(session.sessionId, tab.id);
                void useSessionsStore.getState().runQuery(session.sessionId, tab.id);
              }}
            >
              <RefreshCw />
              <span className="max-sm:hidden @max-[480px]:hidden">Refresh</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" title="Export rows to CSV or JSON">
                  <Download />
                  <span className="max-sm:hidden @max-[480px]:hidden">Export</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Every row the filter matches</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void exportTable(tab, session.sessionId, "csv", true)}>CSV</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportTable(tab, session.sessionId, "json", true)}>JSON</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>This page only</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void exportTable(tab, session.sessionId, "csv", false)}>CSV</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportTable(tab, session.sessionId, "json", false)}>JSON</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
      {/* Data stays mounted under the other views, so its scroll and
          selection survive a trip to Structure or SQL. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", view !== "data" && "hidden")}>
        {ask && <InlineAskStrip tab={tab} ask={ask} />}
        <DataView tab={tab} active={active && view === "data"} onAsk={askInline} flash={flash === "filter"} />
      </div>
      {shown && view === "structure" && <StructureView tab={tab} />}
      {shown && view === "sql" && (
        <div className="min-h-0 flex-1">
          <ScriptConsole tab={tab} active={active} />
        </div>
      )}
    </div>
  );
});
