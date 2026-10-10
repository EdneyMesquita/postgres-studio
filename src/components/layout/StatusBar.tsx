import { GitCommitHorizontal, Loader2, Lock, Plug } from "lucide-react";
import { useConsoleStore } from "../../store/consoleStore";
import { pendingCount } from "../../store/sessionsStore";
import type { ReactNode } from "react";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { OpenConnectionsItems } from "./OpenConnectionsMenu";
import { useActiveConnection, useConnectedCount } from "./useActiveConnection";
import { AssistantStatusItem } from "../assistant/AssistantStatusItem";

interface StatusItemProps {
  className?: string;
  title?: string;
  children: ReactNode;
}

function StatusItem({ className, title, children }: StatusItemProps) {
  return (
    <span title={title} className={cn("inline-flex h-[22px] items-center gap-1.5 rounded-sm px-[7px] whitespace-nowrap", className)}>
      {children}
    </span>
  );
}

/**
 * The 26px strip at the bottom: which server the active tab runs on and how
 * many are connected (a menu to jump to or disconnect them), the
 * transaction state; on the right, the tab's table and row count.
 */
export function StatusBar() {
  const active = useActiveConnection();
  const connected = useConnectedCount();
  const tab = active?.tab;
  const tx = useConsoleStore((s) => (tab ? (s.consoles[tab.id]?.tx ?? "idle") : "idle"));

  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-0.5 overflow-hidden border-t border-seam bg-panel px-2 text-xs text-fg-2">
      {active ? (
        <StatusItem className="min-w-0">
          <ConnectionChip name={active.tab.connection.name} color={active.color} size="dot" />
          <span className="truncate font-medium text-fg">{active.tab.connection.name}</span>
          {active.session?.serverVersion && <span>PostgreSQL {active.session.serverVersion}</span>}
        </StatusItem>
      ) : (
        connected === 0 && <StatusItem>No connection open</StatusItem>
      )}
      {connected > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-[22px] items-center gap-1.5 rounded-sm px-[7px] whitespace-nowrap hover:bg-hover hover:text-fg"
              title="Manage open connections"
            >
              <Plug className="size-3" />
              {connected} connected
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-64">
            <OpenConnectionsItems activeId={active?.tab.connection.id ?? null} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {active?.session?.readOnly && (
        <StatusItem className="text-warn">
          <Lock className="size-3" />
          Read-only
        </StatusItem>
      )}
      {tab?.kind === "table" && pendingCount(tab) > 0 ? (
        <StatusItem className="text-warn">
          <span className="size-[7px] rounded-full bg-warn" />
          {pendingCount(tab)} uncommitted
        </StatusItem>
      ) : tx === "active" || tx === "failed" ? (
        <StatusItem className={tx === "failed" ? "text-danger" : "text-warn"}>
          <span className={cn("size-[7px] rounded-full", tx === "failed" ? "bg-danger" : "bg-warn")} />
          {tx === "failed" ? "Transaction failed" : "In transaction"}
        </StatusItem>
      ) : (
        active && (
          <StatusItem title="Each statement commits on its own">
            <GitCommitHorizontal className="size-3" />
            Auto-commit
          </StatusItem>
        )
      )}
      <span className="flex-1" />
      {tab?.kind === "table" && (
        <>
          <StatusItem className="min-w-0">
            <span className="truncate font-data">
              {tab.database}.{tab.schema}.{tab.table}
            </span>
          </StatusItem>
          {tab.loading ? (
            <StatusItem>
              <Loader2 className="size-3 animate-spin" />
              Running
            </StatusItem>
          ) : (
            <>
              {(tab.exactCount ?? tab.info?.rowEstimate) != null && (
                <StatusItem className="tabular-nums">
                  {tab.exactCount === null ? "~" : ""}
                  {(tab.exactCount ?? tab.info?.rowEstimate ?? 0).toLocaleString("en")} rows
                </StatusItem>
              )}
              {tab.queryMs !== null && <StatusItem className="tabular-nums">{tab.queryMs} ms</StatusItem>}
            </>
          )}
        </>
      )}
      {tab?.kind === "console" && (
        <StatusItem className="font-data">{tab.database}</StatusItem>
      )}
      {tab && <StatusItem>SQL</StatusItem>}
      <AssistantStatusItem />
    </footer>
  );
}
