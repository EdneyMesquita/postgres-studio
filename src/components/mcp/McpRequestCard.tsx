import { useEffect, useState } from "react";
import { Bot, Check, CircleCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { connectionColor } from "@/lib/connectionColor";
import { formatCountdown, MCP_REQUEST_TIMEOUT_MS } from "@/lib/mcp";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useMcpStore } from "../../store/mcpStore";
import type { McpCapability, McpRequestChoice } from "../../types/mcp";
import { SqlText } from "../console/SqlText";

const ASKING: Record<McpCapability, string> = {
  browse: "wants to list objects",
  read: "wants to read",
  write: "wants to write",
  ddl: "wants to change the schema",
  script: "wants to run a script",
  connList: "wants to see saved connections",
  connEdit: "wants to change saved connections",
  connDelete: "wants to delete a saved connection",
  saveScript: "wants to save a script",
};

/** The capability as Settings › MCP server names it. */
const POLICY_NAME: Record<McpCapability, string> = {
  browse: "Listing schemas and tables",
  read: "SELECT and EXPLAIN",
  write: "Insert, update and delete",
  ddl: "Create, alter, drop and truncate",
  script: "Run any SQL",
  connList: "See saved connections",
  connEdit: "Create and edit saved connections",
  connDelete: "Delete saved connections",
  saveScript: "Save queries and scripts",
};

/** The capability in the card's sentence: "<this> is set to Ask". */
const ASKS_FOR: Record<McpCapability, string> = {
  browse: "Listing schemas and tables",
  read: "Reading",
  write: "Writing rows",
  ddl: "Changing the schema",
  script: "Running any SQL",
  connList: "Seeing saved connections",
  connEdit: "Editing saved connections",
  connDelete: "Deleting saved connections",
  saveScript: "Saving scripts",
};

/** Capabilities whose request carries SQL rather than a note of what changes. */
const SQL_CAPS = new Set<McpCapability>(["read", "write", "ddl", "script"]);

const NO_DRY_RUN: Partial<Record<McpCapability, string>> = {
  ddl: "No dry run for schema changes",
  script: "No dry run for scripts",
};

/** Time left before the server refuses the request, ticking each second. */
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="font-mono text-[11px] tabular-nums text-fg-3" title="Refused when this runs out">
      {formatCountdown(MCP_REQUEST_TIMEOUT_MS - (now - at))}
    </span>
  );
}

/**
 * A call an MCP client made that's set to Ask, over the workspace's
 * top-right corner, under the toolbar, until answered: what it would run,
 * where, and the dry run's outcome. One at a time, oldest first; the status
 * bar counts the rest.
 */
export function McpRequestCard() {
  const request = useMcpStore((s) => s.requests[0]);
  const queued = useMcpStore((s) => s.requests.length - 1);
  const answer = useMcpStore((s) => s.answer);
  const profile = useConnectionsStore((s) => s.profiles.find((p) => p.id === request?.connectionId));
  if (!request) return null;

  const respond = (choice: McpRequestChoice) =>
    answer(request.requestId, choice).catch((e) =>
      toast.error("Couldn't answer the request", { description: String(e) }),
    );
  const policy = POLICY_NAME[request.capability] ?? request.capability;
  const noDryRun = NO_DRY_RUN[request.capability];

  return (
    <div
      role="alertdialog"
      aria-labelledby="mcp-request-client"
      // Above any dialog, and clickable while one is open: a request waits on
      // the user even when Settings is in front.
      data-above-dialogs=""
      style={{ pointerEvents: "auto" }}
      className="fixed top-12 right-4 z-[60] w-[min(540px,calc(100%-2rem))] overflow-hidden rounded-md border border-line bg-popover shadow-overlay animate-in fade-in-0 slide-in-from-top-1 duration-200"
    >
      <div className="flex h-8 items-center gap-[7px] border-b border-line-soft pr-2.5 pl-2.5 text-sm text-fg-2">
        <Bot className="size-3.5 shrink-0" />
        <b id="mcp-request-client" className="font-semibold text-fg">
          {request.clientName}
        </b>
        <span className="min-w-0 flex-1 truncate text-fg-3">{ASKING[request.capability] ?? "is asking"} · via MCP</span>
        {queued > 0 && <span className="text-xs text-warn">+{queued} more</span>}
        <Countdown key={request.requestId} at={request.at} />
      </div>
      <div className="flex items-start gap-2 border-b border-line-soft bg-warn/9 px-2.5 py-2 text-sm leading-[1.45] text-fg-2">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" />
        <span>
          <b className="font-medium text-fg">{request.title}</b>
          {request.database && (
            <>
              {" in "}
              <span className="font-data text-fg">{request.database}</span>
            </>
          )}
          {request.connectionName && " on "}
          {profile && (
            <span className="mx-0.5 inline-block">
              <ConnectionChip name={profile.name} color={connectionColor(profile.id, profile.color)} size="dot" />
            </span>
          )}
          {request.connectionName}. {ASKS_FOR[request.capability] ?? policy} is set to Ask.
        </span>
      </div>
      <div className="max-h-[220px] overflow-auto border-b border-line-soft bg-editor px-2.5 py-2 text-xs leading-[18px]">
        {SQL_CAPS.has(request.capability) ? (
          <SqlText text={request.code} />
        ) : (
          <pre className="m-0 font-data whitespace-pre-wrap break-words text-fg">{request.code}</pre>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 py-1.5 pr-1.5 pl-2.5">
        <span className="mr-auto inline-flex items-center gap-[5px] text-xs whitespace-nowrap text-fg-2">
          {request.dryRun ? (
            <>
              <CircleCheck className="size-3 text-ok" />
              Dry run: {request.dryRun}
            </>
          ) : (
            noDryRun && <span className="text-fg-3">{noDryRun}</span>
          )}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void respond("deny")}>
          Deny
        </Button>
        <Button
          size="sm"
          title={`Set ${policy}${request.connectionName ? ` on ${request.connectionName}` : ""} to Allow`}
          onClick={() => void respond("always")}
        >
          {request.connectionId ? "Always allow here" : "Always allow"}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void respond("once")}>
          <Check />
          Allow once
        </Button>
      </div>
    </div>
  );
}
