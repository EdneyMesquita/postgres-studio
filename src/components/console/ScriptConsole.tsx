import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from "react";
import type * as Monaco from "monaco-editor";
import { useConnectionsStore } from "../../store/connectionsStore";
import type { Tab } from "../../store/sessionsStore";
import { defaultScript, useConsoleStore } from "../../store/consoleStore";
import { hasUnsavedEdits, useScriptsStore } from "../../store/scriptsStore";
import { DEFAULT_CONSOLE_SPLIT, useUiStore } from "../../store/uiStore";
import { useAssistantStore } from "../../store/assistantStore";
import { SplitPane } from "../ui/SplitPane";
import { InlineAskStrip } from "../assistant/InlineAskStrip";
import { runRequestOf } from "./runRequest";
import type { RunRequest } from "./runRequest";

// Monaco (and the SQL language on it) loads with the first console shown,
// not with the app: most of the startup bundle was the editor.
const ConsoleEditor = lazy(() => import("./ConsoleEditor").then((m) => ({ default: m.ConsoleEditor })));
import { ConsoleOutputPane } from "./ConsoleOutputPane";
import { ConsoleToolbar } from "./ConsoleToolbar";

/** The statements of `request` to explain: the selection, or the caret's statement. */
function explainText(editor: Monaco.editor.IStandaloneCodeEditor | null): string | null {
  const request = editor ? runRequestOf(editor) : null;
  if (!request) return null;
  if (request.caret === null) return request.sql;
  // the caret's statement: what's between the semicolons around it
  const text = request.sql;
  const before = text.lastIndexOf(";", Math.max(0, request.caret - 1));
  const after = text.indexOf(";", request.caret);
  return text.slice(before + 1, after < 0 ? text.length : after).trim();
}

/**
 * A SQL console: a console tab's, or a table tab's SQL view. `active` is
 * the one on screen alone or in the focused pane; only it takes the
 * window-wide shortcuts, so a split with two consoles saves once.
 */
export function ScriptConsole({ tab, active = true }: { tab: Tab; active?: boolean }) {
  const session = useConnectionsStore((s) => s.sessions[tab.connection.id]);
  const key = tab.id;
  const consoleSession = useConsoleStore((s) => s.consoles[key]);
  const run = useConsoleStore((s) => s.run);
  const cancel = useConsoleStore((s) => s.cancel);
  const explain = useConsoleStore((s) => s.explain);
  const file = useScriptsStore((s) => s.files[key]);
  const layout = useUiStore((s) => s.consoleLayout);
  const split = useUiStore((s) => s.consoleSplit[s.consoleLayout]);
  const setSplit = useUiStore((s) => s.setConsoleSplit);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const onEditor = useCallback((e: Monaco.editor.IStandaloneCodeEditor | null) => {
    editor.current = e;
  }, []);
  const ask = useAssistantStore((s) => (s.inline[key]?.kind === "script" ? s.inline[key] : undefined));
  const reviewOriginal = ask?.state === "review" ? ask.original : null;
  const reviewText = ask?.state === "review" ? ask.proposal : null;
  const proposal = useMemo(
    () => (reviewOriginal !== null && reviewText !== null ? { original: reviewOriginal, text: reviewText } : null),
    [reviewOriginal, reviewText],
  );

  // Ctrl/Cmd+S saves, adding Shift saves to a new file.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      useScriptsStore.getState().save(e.shiftKey);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  if (!session) return null;

  const untouched = defaultScript(tab);
  const script = consoleSession?.script ?? untouched;
  const running = consoleSession?.running ?? false;

  function handleRun(request: RunRequest | null) {
    // Not while a proposal waits for Accept or Reject.
    if (useAssistantStore.getState().inline[key]?.kind === "script") return;
    if (!request || !session) return;
    void run(key, session.sessionId, tab.database, request.sql, request.caret, request.from);
  }

  function handleExplain(analyze: boolean) {
    const text = explainText(editor.current);
    if (!text || !session) return;
    void explain(key, session.sessionId, tab.database, text, analyze);
  }

  // where the failed statement's error points, in the editor's text
  const failed = consoleSession?.run?.results.find((r) => r.error);
  const errorAt =
    failed?.error?.position && consoleSession ? consoleSession.ranFrom + failed.start + failed.error.position - 1 : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <ConsoleToolbar
        tab={tab}
        dirty={hasUnsavedEdits(script, file, untouched)}
        running={running}
        onRun={() => handleRun(editor.current ? runRequestOf(editor.current) : { sql: script, caret: null, from: 0 })}
        onRunAll={() => handleRun({ sql: script, caret: null, from: 0 })}
        onExplain={handleExplain}
        onCancel={() => void cancel(key)}
      />
      {ask && <InlineAskStrip tab={tab} ask={ask} />}
      <SplitPane
        direction={layout === "side" ? "horizontal" : "vertical"}
        ratio={split}
        onRatioChange={(ratio) => setSplit(layout, ratio)}
        defaultRatio={DEFAULT_CONSOLE_SPLIT}
        ariaLabel="Resize editor and output"
        first={
          <Suspense fallback={<div className="h-full bg-editor" aria-busy="true" />}>
            <ConsoleEditor
              consoleKey={key}
              script={script}
              onRun={handleRun}
              onEditor={onEditor}
              proposal={proposal}
              errorAt={errorAt}
            />
          </Suspense>
        }
        second={<ConsoleOutputPane tab={tab} session={consoleSession} />}
      />
    </div>
  );
}
