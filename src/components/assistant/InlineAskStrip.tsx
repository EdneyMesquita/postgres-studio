import { useEffect, useRef } from "react";
import { Info, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { AGENT_NAMES, useAssistantStore } from "../../store/assistantStore";
import type { InlineAsk } from "../../store/assistantStore";
import type { Tab } from "../../store/sessionsStore";
import { filterChangeSummary, lineDiff, scriptChangeSummary } from "../../lib/assistant/diff";
import { dryRunText, useDryRun } from "./useDryRun";

/** "“…” · 2 conditions added · 23 rows match" for a proposed condition. */
function FilterReview({ ask, tab }: { ask: InlineAsk; tab: Tab }) {
  const table = tab.kind === "table" ? `${tab.schema}.${tab.table}` : null;
  const proposal = { kind: "filter" as const, table, code: ask.proposal ?? "" };
  const dry = useDryRun(tab.connection.id, tab.database, table, proposal);
  const matched =
    dry?.state === "done"
      ? `${dry.count.toLocaleString("en")} ${dry.count === 1 ? "row matches" : "rows match"}`
      : dry
        ? dryRunText(dry)
        : "";
  return (
    <>
      “{ask.prompt.trim()}” · <b className="font-medium text-fg">{filterChangeSummary(ask.original, ask.proposal ?? "")}</b>
      {matched && ` · ${matched}`}
    </>
  );
}

/**
 * Ctrl+I under a filter bar or a console toolbar: ask in words, watch the
 * agent work, then accept or reject the change shown in place.
 */
export function InlineAskStrip({ tab, ask }: { tab: Tab; ask: InlineAsk }) {
  const agent = useAssistantStore((s) => s.agent);
  const { setInlinePrompt, generateInline, acceptInline, closeInline, continueInline, answerApproval } =
    useAssistantStore.getState();
  const input = useRef<HTMLInputElement>(null);
  const name = AGENT_NAMES[agent];
  const isFilter = ask.kind === "filter";

  useEffect(() => {
    if (ask.state === "ask") input.current?.focus();
  }, [ask.state]);

  // Enter accepts and Esc rejects a proposal, wherever the focus is -
  // except in a field, where those keys belong to it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (e.key === "Escape" && (ask.state !== "ask" || target === input.current)) {
        if (target.closest("[role=menu], [role=dialog]")) return;
        e.preventDefault();
        closeInline(tab.id);
      } else if (e.key === "Enter" && ask.state === "review" && !target.closest("input, textarea, .monaco-editor, button")) {
        e.preventDefault();
        acceptInline(tab.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ask.state, tab.id, closeInline, acceptInline]);

  const status = "flex h-[30px] min-w-0 flex-1 items-center gap-2 text-sm text-fg-2";
  let body;
  if (ask.state === "ask") {
    body = (
      <>
        <label className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md border border-ring bg-field pr-2 pl-[9px] ring-2 ring-ring/30">
          <Sparkles className="size-3.5 shrink-0 text-accent-text" />
          <input
            ref={input}
            value={ask.prompt}
            onChange={(e) => setInlinePrompt(tab.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void generateInline(tab.id);
              }
            }}
            placeholder={isFilter ? "Describe the rows you want, in words" : "Describe the change to this SQL"}
            aria-label={isFilter ? "Describe the condition" : "Describe the change"}
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-3"
          />
          <span className="shrink-0 text-xs text-fg-3">{name}</span>
        </label>
        <Button variant="primary" disabled={!ask.prompt.trim()} onClick={() => void generateInline(tab.id)}>
          Generate
          <Kbd>⏎</Kbd>
        </Button>
        <Button variant="ghost" onClick={() => closeInline(tab.id)}>
          Cancel
          <Kbd>Esc</Kbd>
        </Button>
      </>
    );
  } else if (ask.state === "working") {
    body = ask.approval ? (
      <>
        <div className={status}>
          <Info className="size-3.5 shrink-0 text-accent-text" />
          <span className="truncate">
            <b className="font-medium text-fg">{name}</b> wants to read {ask.approval.limit} rows from{" "}
            {ask.approval.database}
            {ask.approval.table ? `.${ask.approval.table}` : ""}; their values go to {ask.approval.provider}.
          </span>
        </div>
        <Button size="sm" variant="primary" onClick={() => void answerApproval(ask.approval!.requestId, "once")}>
          Allow once
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void answerApproval(ask.approval!.requestId, "deny")}>
          Deny
        </Button>
      </>
    ) : (
      <>
        <div className={status}>
          <Loader2 className="size-3.5 shrink-0 animate-spin text-accent-text" />
          <span className="truncate">
            <b className="font-medium text-fg">{name}</b>{" "}
            {ask.step ? `· ${ask.step}…` : isFilter && tab.kind === "table" ? `is reading ${tab.schema}.${tab.table}…` : "is reading the SQL…"}
          </span>
        </div>
        <Button variant="ghost" onClick={() => closeInline(tab.id)}>
          Stop
          <Kbd>Esc</Kbd>
        </Button>
      </>
    );
  } else if (ask.state === "error") {
    body = (
      <>
        <div className={cn(status, "text-danger")} title={ask.error ?? undefined}>
          <Info className="size-3.5 shrink-0" />
          <span className="truncate">{ask.error}</span>
        </div>
        <Button variant="ghost" onClick={() => continueInline(tab.id)}>
          Continue in Assistant
        </Button>
        <Button variant="ghost" onClick={() => closeInline(tab.id)}>
          Close
          <Kbd>Esc</Kbd>
        </Button>
      </>
    );
  } else {
    const diff = !isFilter ? lineDiff(ask.original, ask.proposal ?? "") : null;
    body = (
      <>
        <div className={status}>
          <Sparkles className="size-3.5 shrink-0 text-accent-text" />
          <span className="truncate">
            {isFilter ? (
              <FilterReview ask={ask} tab={tab} />
            ) : (
              <>
                “{ask.prompt.trim()}” ·{" "}
                <b className="font-medium text-fg">{scriptChangeSummary(diff!.added.length, diff!.removed)}</b>
              </>
            )}
          </span>
        </div>
        <Button variant="ghost" onClick={() => continueInline(tab.id)}>
          Continue in Assistant
        </Button>
        <Button variant="ghost" onClick={() => closeInline(tab.id)}>
          Reject
          <Kbd>Esc</Kbd>
        </Button>
        <Button variant="primary" onClick={() => acceptInline(tab.id)}>
          Accept
          <Kbd>⏎</Kbd>
        </Button>
      </>
    );
  }

  return (
    <div
      role="group"
      aria-label="Ask the Assistant"
      className={cn(
        "flex flex-none animate-fade items-center gap-2 border-b border-line px-2.5 pb-2",
        !isFilter && "pt-2",
      )}
    >
      {body}
    </div>
  );
}
