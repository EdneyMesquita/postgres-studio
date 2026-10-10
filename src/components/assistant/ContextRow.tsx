import { Lock } from "lucide-react";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConnectionColor } from "@/lib/connectionColor";
import type { AssistantSession } from "../../store/assistantStore";

/** Where the session reads - always visible - and that it can't write. */
export function ContextRow({ session }: { session: AssistantSession }) {
  const color = useConnectionColor(session.connectionId);
  const where = session.table ? `${session.database}.${session.table}` : session.database;
  return (
    <div className="flex min-w-0 flex-none items-center gap-1.5 px-3 pb-2 text-sm text-fg-2">
      <span className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md bg-fg/6 px-2">
        <ConnectionChip name={session.connectionName} color={color} size="sm" />
        <b className="truncate font-mono text-sm font-normal text-fg [font-variant-ligatures:none]">{where}</b>
        <span className="shrink-0 whitespace-nowrap">on {session.connectionName}</span>
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="ml-auto inline-flex shrink-0 cursor-default items-center gap-1 text-xs whitespace-nowrap text-fg-3">
            <Lock className="size-3" />
            Read-only
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          The agent runs with only Postgres Studio's tools: list, sample, find and aggregate with a limit, explain. Its own
          shell and file tools are off, $out and $merge are refused, and it never sees connection strings.
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
