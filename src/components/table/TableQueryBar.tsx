import { useId } from "react";
import type { KeyboardEvent } from "react";
import { Play, Sparkles } from "lucide-react";
import { useConnectionsStore } from "../../store/connectionsStore";
import { hasPendingEdits, useSessionsStore } from "../../store/sessionsStore";
import type { TableTab } from "../../store/sessionsStore";
import { confirm } from "../../store/confirmStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { QueryField } from "../query/QueryField";
import { QueryNumberField } from "../query/QueryNumberField";
import { ProposedFilter } from "../assistant/ProposedFilter";
import { useAssistantStore } from "../../store/assistantStore";

interface TableQueryBarProps {
  tab: TableTab;
  onAsk?: () => void;
  /** The WHERE field flashes after the Assistant writes it. */
  flash?: boolean;
}

/** Asks before a new page throws away edits not committed yet. */
export async function confirmDiscard(tab: TableTab): Promise<boolean> {
  if (!hasPendingEdits(tab)) return true;
  return confirm({
    title: "Discard uncommitted changes?",
    message: `${tab.table} has changes that aren't committed. Running the query again discards them.`,
    confirmLabel: "Discard and run",
    danger: true,
  });
}

/** WHERE, ORDER BY, LIMIT and OFFSET over the table, and Run. */
export function TableQueryBar({ tab, onAsk, flash = false }: TableQueryBarProps) {
  const session = useConnectionsStore((s) => s.sessions[tab.connection.id]);
  const updateTab = useSessionsStore((s) => s.updateTab);
  const runQuery = useSessionsStore((s) => s.runQuery);
  const cancelQuery = useSessionsStore((s) => s.cancelQuery);
  const whereId = useId();
  const orderId = useId();
  // While the Assistant's condition waits for Accept, it shows in place of WHERE.
  const proposed = useAssistantStore((s) => {
    const ask = s.inline[tab.id];
    return ask?.kind === "filter" && ask.state === "review" && ask.proposal !== null ? ask : null;
  });
  if (!session) return null;

  const pending = hasPendingEdits(tab);
  /** A new condition or order starts again from the first page; a new limit or offset doesn't. */
  const submit = async (fromStart = true) => {
    if (!(await confirmDiscard(tab))) return;
    if (fromStart) updateTab(tab.id, { offset: 0 });
    await runQuery(session.sessionId, tab.id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };
  const onPageKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit(false);
    }
  };

  return (
    <div className="@container flex-none border-b border-line px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {proposed ? (
          <ProposedFilter original={proposed.original} proposal={proposed.proposal ?? ""} />
        ) : (
          <QueryField
            label="where"
            htmlFor={whereId}
            className={cn(
              "min-w-[200px] flex-1 @max-[760px]:basis-full",
              flash && "animate-flash-box",
            )}
          >
            <Input
              id={whereId}
              spellCheck={false}
              value={tab.whereText}
              placeholder="any condition, e.g. status = 'paid' AND total > 100"
              onChange={(e) => updateTab(tab.id, { whereText: e.target.value })}
              onKeyDown={onKeyDown}
              className="h-full rounded-none border-0 bg-transparent pr-2 pl-0 font-data text-data focus-visible:ring-0"
            />
            {onAsk && (
              <button
                type="button"
                onClick={onAsk}
                title="Ask the Assistant (Ctrl I)"
                aria-label="Ask the Assistant for a condition"
                className="mr-[3px] grid size-6 shrink-0 place-items-center rounded-sm text-fg-3 hover:bg-hover hover:text-accent-text"
              >
                <Sparkles className="size-3.5" />
              </button>
            )}
          </QueryField>
        )}
        <QueryField label="order by" htmlFor={orderId} className="w-[220px] min-w-[140px] flex-[0_1_220px]">
          <Input
            id={orderId}
            spellCheck={false}
            value={tab.orderByText}
            placeholder="id DESC"
            onChange={(e) => updateTab(tab.id, { orderByText: e.target.value })}
            onKeyDown={onKeyDown}
            className="h-full rounded-none border-0 bg-transparent pr-2 pl-0 font-data text-data focus-visible:ring-0"
          />
        </QueryField>
        <QueryNumberField
          label="limit"
          value={tab.limit}
          onChange={(limit) => updateTab(tab.id, { limit: Math.max(1, limit || 1) })}
          onKeyDown={onPageKeyDown}
        />
        <QueryNumberField
          label="offset"
          value={tab.offset}
          onChange={(offset) => updateTab(tab.id, { offset: Math.max(0, offset || 0) })}
          onKeyDown={onPageKeyDown}
        />
        {tab.loading ? (
          <Button variant="secondary" onClick={() => cancelQuery(tab.id)}>
            Cancel
          </Button>
        ) : (
          <Button
            variant={pending ? "secondary" : "primary"}
            onClick={() => void submit()}
            title={pending ? "Runs again, discarding the changes not committed" : undefined}
          >
            <Play />
            Run
            <Kbd>⏎</Kbd>
          </Button>
        )}
      </div>
    </div>
  );
}
