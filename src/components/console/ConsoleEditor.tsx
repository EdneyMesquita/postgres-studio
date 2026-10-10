import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { lineDiff } from "../../lib/assistant/diff";
import { currentConsoleTarget, useConsoleStore } from "../../store/consoleStore";
import { useThemeStore } from "../../store/themeStore";
import { monacoTheme } from "../../lib/themes";
import { attachSqlCompletion, SQL_LANGUAGE } from "../../lib/sqlCompletion";
import { addEditorCommand } from "../../lib/monaco";
import { runRequestOf } from "./runRequest";
import type { RunRequest } from "./runRequest";

interface ConsoleEditorProps {
  /** The console's key, its tab id. */
  consoleKey: string;
  script: string;
  /** Bound once per mount; must read what it runs at call time. */
  onRun: (request: RunRequest) => void;
  /** Hands the editor out, so the toolbar's Run can read the caret too. */
  onEditor?: (editor: Monaco.editor.IStandaloneCodeEditor | null) => void;
  /** SQL the Assistant proposes: shown read-only, added lines marked, until accepted or rejected. */
  proposal?: { original: string; text: string } | null;
  /** A failed statement's position in the editor's text (character offset), to mark. */
  errorAt?: number | null;
}

/** DESIGN.md code style: 13px mono on a 20px line, no ligatures. */
const FONT_FAMILY = '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** The console's Monaco editor: SQL with completion; Ctrl+Enter runs the statement at the caret. */
export function ConsoleEditor({ consoleKey: key, script, onRun, onEditor, proposal, errorAt }: ConsoleEditorProps) {
  const themeId = useThemeStore((s) => s.themeId);
  const setScript = useConsoleStore((s) => s.setScript);
  const detachCompletion = useRef<(() => void) | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const decorations = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const errorMarks = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);

  useEffect(
    () => () => {
      detachCompletion.current?.();
      onEditor?.(null);
    },
    [onEditor],
  );

  // Mark the lines a proposal adds; clear them once it's accepted or rejected.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    decorations.current?.clear();
    if (!proposal) return;
    const { added } = lineDiff(proposal.original, proposal.text);
    decorations.current = editor.createDecorationsCollection(
      added.map((line) => ({
        range: { startLineNumber: line + 1, startColumn: 1, endLineNumber: line + 1, endColumn: 1 },
        options: { isWholeLine: true, className: "assistant-added-line", linesDecorationsClassName: "assistant-added-gutter" },
      })),
    );
    if (added.length) editor.revealLineInCenterIfOutsideViewport(added[0] + 1);
  }, [proposal]);

  // Underline where the server said the error is.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    errorMarks.current?.clear();
    if (!editor || !model || errorAt === null || errorAt === undefined) return;
    const start = model.getPositionAt(errorAt);
    const word = model.getWordAtPosition(start);
    const end = word ? { lineNumber: start.lineNumber, column: word.endColumn } : { lineNumber: start.lineNumber, column: start.column + 1 };
    errorMarks.current = editor.createDecorationsCollection([
      {
        range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
        options: { inlineClassName: "sql-error-mark", hoverMessage: { value: "The server reported the error here" } },
      },
    ]);
    editor.revealPositionInCenterIfOutsideViewport(start);
  }, [errorAt]);

  return (
    <div className="h-full bg-editor">
      <Editor
        // Remounted per console: switching `path` on one editor wrote the
        // incoming script into the outgoing tab's model.
        key={key}
        language={SQL_LANGUAGE}
        theme={monacoTheme(themeId)}
        value={proposal ? proposal.text : script}
        onChange={(value) => {
          if (!proposal) setScript(key, value ?? "");
          errorMarks.current?.clear();
        }}
        options={{
          minimap: { enabled: false },
          fontFamily: FONT_FAMILY,
          fontSize: 13,
          lineHeight: 20,
          fontLigatures: false,
          padding: { top: 8, bottom: 8 },
          scrollBeyondLastLine: false,
          overviewRulerLanes: 0,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          automaticLayout: true,
          readOnly: !!proposal,
          lineDecorationsWidth: 14,
          tabSize: 2,
          wordBasedSuggestions: "off",
          quickSuggestions: { other: true, comments: false, strings: false },
        }}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          monacoRef.current = monaco;
          onEditor?.(editor);
          void document.fonts?.ready.then(() => monaco.editor.remeasureFonts());
          detachCompletion.current?.();
          const model = editor.getModel();
          if (model) {
            detachCompletion.current = attachSqlCompletion(model, () => {
              const target = currentConsoleTarget();
              return target?.session
                ? { sessionId: target.session.sessionId, connectionId: target.tab.connection.id, database: target.database }
                : null;
            });
          }
          addEditorCommand(editor, monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
            const request = runRequestOf(editor);
            if (request) onRun(request);
          });
          addEditorCommand(editor, monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
            const request = runRequestOf(editor, true);
            if (request) onRun(request);
          });
        }}
      />
    </div>
  );
}
