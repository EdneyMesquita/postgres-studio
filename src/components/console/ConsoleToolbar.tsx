import { Check, ChevronDown, ListVideo, Play, Save, Sparkles, Undo2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { SegmentOption } from "@/components/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Tab } from "../../store/sessionsStore";
import { useScriptsStore } from "../../store/scriptsStore";
import { useConsoleStore } from "../../store/consoleStore";
import type { TxMode } from "../../store/consoleStore";
import { useConnectionsStore } from "../../store/connectionsStore";
import { confirm } from "../../store/confirmStore";
import { ConsoleLayoutToggle } from "./ConsoleLayoutToggle";
import { ConsoleTargetPill } from "./ConsoleTargetPill";
import { ScriptFileChip } from "./ScriptFileChip";
import { FromAssistantTag } from "../assistant/FromAssistantTag";
import { useAssistantStore } from "../../store/assistantStore";

interface ConsoleToolbarProps {
  tab: Tab;
  dirty: boolean;
  running: boolean;
  onRun: () => void;
  onRunAll: () => void;
  onExplain: (analyze: boolean) => void;
  onCancel: () => void;
}

const modes: SegmentOption<TxMode>[] = [
  { value: "auto", label: "Auto-commit", title: "Each statement commits on its own" },
  { value: "manual", label: "Manual", title: "Statements run in a transaction until you commit or roll back" },
];

/** Where the SQL runs, the file it saves to, the transaction mode, Explain, Save and Run. */
export function ConsoleToolbar({ tab, dirty, running, onRun, onRunAll, onExplain, onCancel }: ConsoleToolbarProps) {
  const key = tab.id;
  const file = useScriptsStore((s) => s.files[key]);
  const saving = useScriptsStore((s) => s.saving);
  const saveError = useScriptsStore((s) => s.saveError);
  const saveScript = useScriptsStore((s) => s.save);
  const detach = useScriptsStore((s) => s.detach);
  const askInline = useAssistantStore((s) => s.askInline);
  const pending = useAssistantStore((s) => s.inline[key]?.kind === "script");
  const tx = useConsoleStore((s) => s.consoles[key]?.tx ?? "idle");
  const txMode = useConsoleStore((s) => s.consoles[key]?.txMode ?? "auto");
  const setTxMode = useConsoleStore((s) => s.setTxMode);
  const endTransaction = useConsoleStore((s) => s.endTransaction);
  const session = useConnectionsStore((s) => s.sessions[tab.connection.id]);
  const inTransaction = tx === "active" || tx === "failed";

  async function changeMode(mode: TxMode) {
    if (!session) return;
    if (mode === "auto" && tx === "active") {
      const commit = await confirm({
        title: "A transaction is open",
        message: "Commit it before switching to auto-commit? Cancel keeps it open; you can still commit or roll back.",
        confirmLabel: "Commit",
      });
      if (commit) await endTransaction(key, session.sessionId, tab.database, "COMMIT");
    }
    await setTxMode(key, session.sessionId, tab.database, mode);
  }

  return (
    <div className="@container flex h-9 shrink-0 items-center gap-2 border-b border-line px-2.5">
      <ConsoleTargetPill tab={tab} />
      {/* The pane header and the tab name the file too; a narrow bar keeps Run. */}
      <span className="contents @max-[520px]:hidden">
        <ScriptFileChip file={file} dirty={dirty} onDetach={() => detach(key)} />
      </span>
      {tab.kind === "console" && tab.fromAssistant && <FromAssistantTag />}
      {saveError && (
        <span className="shrink-0 text-sm text-danger" title={saveError} role="alert">
          Save failed
        </span>
      )}
      <span className="flex-1" />
      {session && !session.poolerMode && (
        <span className="contents @max-[900px]:hidden">
          <SegmentedControl aria-label="Transaction mode" value={txMode} onChange={(m) => void changeMode(m)} options={modes} />
        </span>
      )}
      {inTransaction && session && (
        <>
          <span
            className={cn("inline-flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap", tx === "failed" ? "text-danger" : "text-warn")}
            title={tx === "failed" ? "A statement failed; only ROLLBACK works now" : "Changes wait for COMMIT"}
          >
            <span className={cn("size-[7px] rounded-full", tx === "failed" ? "bg-danger" : "bg-warn")} aria-hidden />
            <span className="@max-[1150px]:sr-only">{tx === "failed" ? "Transaction failed" : "In transaction"}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => void endTransaction(key, session.sessionId, tab.database, "ROLLBACK")}>
            <Undo2 />
            Rollback
          </Button>
          {tx === "active" && (
            <Button variant="secondary" size="sm" onClick={() => void endTransaction(key, session.sessionId, tab.database, "COMMIT")}>
              <Check />
              Commit
            </Button>
          )}
        </>
      )}
      <span className="contents @max-[980px]:hidden">
        <ConsoleLayoutToggle />
      </span>
      <Button variant="ghost" title="Ask the Assistant to change this SQL (Ctrl I)" aria-label="Ask the Assistant" onClick={askInline}>
        <Sparkles />
        <span className="@max-[860px]:hidden">Ask</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" title="Show the plan of the statement at the caret">
            <Zap />
            <span className="@max-[760px]:hidden">Explain</span>
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onExplain(false)}>Explain (plan only, nothing runs)</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onExplain(true)}>Explain analyze (runs it, then rolls back)</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" disabled={saving} title="Save (Ctrl S). Save as a new file: Ctrl Shift S" aria-label="Save" onClick={() => saveScript()}>
        <Save />
        <span className="max-sm:hidden @max-[760px]:hidden">Save</span>
      </Button>
      {running ? (
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      ) : (
        <>
          <Button variant="ghost" title="Run every statement (Ctrl Shift ⏎)" aria-label="Run all" onClick={onRunAll}>
            <ListVideo />
            <span className="@max-[700px]:hidden">Run all</span>
          </Button>
          <Button
            variant={pending ? "secondary" : "primary"}
            disabled={pending}
            title={pending ? "Accept or reject the proposal first" : "Run the statement at the caret, or the selection (Ctrl ⏎)"}
            onClick={onRun}
          >
            <Play />
            Run
            <Kbd>Ctrl ⏎</Kbd>
          </Button>
        </>
      )}
    </div>
  );
}
