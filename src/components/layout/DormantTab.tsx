import { Activity, CircleAlert, Loader2, RotateCw, SquareTerminal, Table2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { useConnectionColor } from "@/lib/connectionColor";
import { useConnectionsStore } from "../../store/connectionsStore";
import { retryDormantTab } from "../../store/sessionRestore";
import type { Tab } from "../../store/sessionsStore";
import { tabName } from "../tabs/tabName";

const ICONS = { table: Table2, console: SquareTerminal, diagram: Workflow, activity: Activity } as const;

/**
 * A tab reopened from the last session whose connection isn't up yet:
 * connecting, or why it couldn't, with a way to try again. A table tab
 * runs its query as soon as the connection is live.
 */
export function DormantTab({ tab }: { tab: Tab }) {
  const color = useConnectionColor(tab.connection.id);
  const connecting = useConnectionsStore((s) => Boolean(s.connecting[tab.connection.id]));
  const error = useConnectionsStore((s) => s.connectErrors[tab.connection.id]);
  const Icon = ICONS[tab.kind];

  return (
    <div className="grid h-full min-h-0 place-content-center justify-items-center gap-2 overflow-auto bg-editor px-4 py-6 text-center text-fg-2">
      <span className="grid size-10 place-items-center rounded-lg bg-row-hover text-fg-3">
        <Icon className="size-5" />
      </span>
      <b className="font-data text-base font-semibold text-fg">{tabName(tab)}</b>
      <span className="inline-flex items-center gap-1.5 text-sm">
        <ConnectionChip name={tab.connection.name} color={color} size="dot" />
        {tab.connection.name}
      </span>
      {error ? (
        <>
          <p role="alert" className="m-0 flex max-w-[440px] items-start gap-1.5 text-left text-sm leading-normal text-danger">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="break-words">Couldn&apos;t connect: {error}</span>
          </p>
          <Button className="mt-1" onClick={() => retryDormantTab(tab.connection.id)}>
            <RotateCw className="size-3.5" />
            Try again
          </Button>
        </>
      ) : (
        <>
          <p className="m-0 inline-flex items-center gap-1.5 text-sm" role="status">
            <Loader2 className="size-3.5 animate-spin" />
            {connecting ? `Connecting to ${tab.connection.name}…` : "Reopened from your last session"}
          </p>
          <span className="text-xs text-fg-3">
            {tab.kind === "table" ? "It runs its query once connected." : "It opens once connected."}
          </span>
        </>
      )}
    </div>
  );
}
