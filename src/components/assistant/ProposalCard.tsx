import { memo } from "react";
import {
  Check,
  CircleCheck,
  Copy,
  FileCode,
  Funnel,
  Play,
  SquareTerminal,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { useConnectionColor } from "@/lib/connectionColor";
import { cn } from "@/lib/utils";
import { AGENT_NAMES } from "../../store/assistantStore";
import type { AssistantSession } from "../../store/assistantStore";
import { scriptWrites } from "../../lib/assistant/answer";
import type { Proposal } from "../../lib/assistant/answer";
import { CodeBlock } from "./CodeBlock";
import { applyToQuery, copyProposal, openInConsole, proposalTable, undoApplied } from "./proposalActions";
import { dryRunText, useDryRun } from "./useDryRun";

interface ProposalCardProps {
  session: AssistantSession;
  cardId: string;
  proposal: Proposal;
}

const TITLES = { filter: "Condition", script: "SQL" } as const;
const ICONS = { filter: Funnel, script: FileCode } as const;

/**
 * A WHERE condition or SQL the agent wrote, with where it runs, what a
 * read-only dry run returned, and the one action that puts it to use. SQL
 * that writes says so; nothing here runs it.
 */
export const ProposalCard = memo(function ProposalCard({ session, cardId, proposal }: ProposalCardProps) {
  const color = useConnectionColor(session.connectionId);
  const collection = proposalTable(session, proposal);
  const dry = useDryRun(session.connectionId, session.database, collection, proposal);
  const applied = session.applied[cardId];
  const Icon = ICONS[proposal.kind];
  const isScript = proposal.kind === "script";
  const writes = isScript ? scriptWrites(proposal.code) : [];
  const written = [...new Set(writes.map((w) => w.table).filter(Boolean))] as string[];
  const methods = [...new Set(writes.map((w) => w.command))];
  const where = isScript || !collection ? session.database : `${session.database}.${collection}`;

  return (
    <div className="overflow-hidden rounded-md border border-line bg-editor">
      <div className="flex h-8 items-center gap-[7px] border-b border-line-soft pr-1 pl-2.5 text-sm text-fg-2">
        <Icon className="size-3.5 shrink-0" />
        <b className="font-semibold text-fg">{TITLES[proposal.kind]}</b>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-fg-3">
          <ConnectionChip name={session.connectionName} color={color} size="dot" />
          <span className="truncate">
            {where} on {session.connectionName}
            {written.length > 0 && ` · writes ${written.join(", ")}`}
          </span>
        </span>
        {!isScript && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Open in console"
            aria-label="Open in console"
            onClick={() => openInConsole(session, cardId, proposal)}
          >
            <SquareTerminal />
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" title="Copy" aria-label={`Copy ${TITLES[proposal.kind].toLowerCase()}`} onClick={() => copyProposal(proposal)}>
          <Copy />
        </Button>
      </div>
      {writes.length > 0 && (
        <div className="flex items-start gap-2 border-b border-line-soft bg-warn/9 px-2.5 py-2 text-sm text-fg-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <span>
            <b className="font-medium text-fg">
              Writes to {written.length ? written.map((c) => `${session.database}.${c}`).join(", ") : session.database} on{" "}
              {session.connectionName}
            </b>{" "}
            with <code className="rounded-[3px] bg-fg/8 px-1 font-mono text-xs text-fg">{methods.join(", ")}</code>.{" "}
            {AGENT_NAMES[session.agent]} did not run it; it runs only when you press Run in the console.
          </span>
        </div>
      )}
      <CodeBlock code={proposal.code} />
      <div className="flex items-center gap-1 border-t border-line-soft py-1.5 pr-1.5 pl-2.5">
        <span
          className={cn(
            "mr-auto inline-flex min-w-0 items-center gap-[5px] truncate text-xs text-fg-2",
            dry?.state === "error" && "text-danger",
          )}
          title={dry?.state === "error" ? dry.message : undefined}
        >
          {dry?.state === "done" && <CircleCheck className="size-3 shrink-0 text-ok" />}
          {dry ? dryRunText(dry) : isScript ? "Not run" : ""}
        </span>
        {applied ? (
          <>
            <span className="inline-flex h-6 items-center gap-1 px-2 text-sm text-ok">
              <Check className="size-3.5" />
              {applied.kind === "query" ? "Applied" : "Opened in console"}
            </span>
            {applied.kind === "query" && (
              <Button size="sm" variant="ghost" onClick={() => void undoApplied(session, cardId)}>
                <Undo2 />
                Undo
              </Button>
            )}
          </>
        ) : isScript ? (
          <Button size="sm" variant="primary" data-proposal-primary="" onClick={() => openInConsole(session, cardId, proposal)}>
            <SquareTerminal />
            Open in console
            <Kbd>Ctrl ⏎</Kbd>
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            data-proposal-primary=""
            disabled={!collection}
            title={collection ? undefined : "The proposal doesn't name its table"}
            onClick={() => void applyToQuery(session, cardId, proposal)}
          >
            <Play />
            Apply condition
            <Kbd>Ctrl ⏎</Kbd>
          </Button>
        )}
      </div>
    </div>
  );
});
