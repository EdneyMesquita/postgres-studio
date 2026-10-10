import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import { registerSqlCompletion } from "./sqlCompletion";
import { registerStudioLanguages } from "./studioLanguages";

// Bundle Monaco (and its web workers) via Vite instead of letting
// @monaco-editor/react fetch them from a CDN at runtime - this app needs to
// work fully offline against local/private databases. The package's
// `exports` map is `"./*.js": "./esm/vs/*.js"`, so subpaths must omit the
// `esm/vs` prefix (and keep the `.js` extension) or resolution fails.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new JsonWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });
registerStudioLanguages(monaco);
registerSqlCompletion(monaco);

// Editor themes in the app's own colors (DESIGN.md tokens), so the console
// and the query fields read as part of the window rather than as VS Code.
monaco.editor.defineTheme("postgres-studio-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "7A7E85", fontStyle: "italic" },
    { token: "keyword", foreground: "CF8E6D" },
    { token: "string", foreground: "6AAB73" },
    { token: "string.key.json", foreground: "C77DBB" },
    { token: "string.value.json", foreground: "6AAB73" },
    { token: "number", foreground: "2AACB8" },
    { token: "regexp", foreground: "6AAB73" },
    { token: "keyword.json", foreground: "CF8E6D" },
    { token: "delimiter", foreground: "8C8F96" },
    { token: "identifier", foreground: "DFE1E5" },
    { token: "type", foreground: "56A8F5" },
    { token: "predefined", foreground: "56A8F5" },
    { token: "operator", foreground: "CF8E6D" },
    { token: "string.sql", foreground: "6AAB73" },
    { token: "identifier.quote", foreground: "DFE1E5" },
  ],
  colors: {
    "editor.background": "#1E1F22",
    "editor.foreground": "#DFE1E5",
    "editorLineNumber.foreground": "#6F737A",
    "editorLineNumber.activeForeground": "#DFE1E5",
    "editor.lineHighlightBackground": "#26282C",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#2E436E",
    "editor.inactiveSelectionBackground": "#25324A",
    "editorCursor.foreground": "#DFE1E5",
    "editorIndentGuide.background1": "#2F3135",
    "editorWidget.background": "#2B2D30",
    "editorWidget.border": "#393B40",
    "editorSuggestWidget.background": "#2B2D30",
    "editorSuggestWidget.border": "#393B40",
    "editorSuggestWidget.selectedBackground": "#2E436E",
    "editorHoverWidget.background": "#2B2D30",
    "editorHoverWidget.border": "#393B40",
    "scrollbarSlider.background": "#595D6466",
    "scrollbarSlider.hoverBackground": "#595D64AA",
    "focusBorder": "#3574F0",
  },
});
monaco.editor.defineTheme("postgres-studio-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "8C8C8C", fontStyle: "italic" },
    { token: "keyword", foreground: "0033B3" },
    { token: "string", foreground: "067D17" },
    { token: "string.key.json", foreground: "871094" },
    { token: "string.value.json", foreground: "067D17" },
    { token: "number", foreground: "1750EB" },
    { token: "regexp", foreground: "067D17" },
    { token: "keyword.json", foreground: "0033B3" },
    { token: "delimiter", foreground: "6E7180" },
    { token: "identifier", foreground: "1E1F22" },
    { token: "type", foreground: "00627A" },
    { token: "predefined", foreground: "00627A" },
    { token: "operator", foreground: "0033B3" },
    { token: "string.sql", foreground: "067D17" },
    { token: "identifier.quote", foreground: "1E1F22" },
  ],
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#1E1F22",
    "editorLineNumber.foreground": "#8A8E9C",
    "editorLineNumber.activeForeground": "#1E1F22",
    "editor.lineHighlightBackground": "#F4F6FA",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#D5E1FF",
    "editor.inactiveSelectionBackground": "#E8EEFD",
    "editorCursor.foreground": "#1E1F22",
    "editorIndentGuide.background1": "#EFF0F3",
    "editorWidget.background": "#FFFFFF",
    "editorWidget.border": "#E4E6EB",
    "editorSuggestWidget.background": "#FFFFFF",
    "editorSuggestWidget.border": "#E4E6EB",
    "editorSuggestWidget.selectedBackground": "#D5E1FF",
    "editorHoverWidget.background": "#FFFFFF",
    "editorHoverWidget.border": "#E4E6EB",
    "scrollbarSlider.background": "#8A8E9C55",
    "scrollbarSlider.hoverBackground": "#8A8E9C99",
    "focusBorder": "#3574F0",
  },
});

let ownKeys = 0;

/**
 * `editor.addCommand`, but only for this editor. Monaco keeps keybindings
 * in one service shared by every editor, and its `addCommand` doesn't tie
 * the binding to the editor it's called on: with several editors bound to
 * the same key, the last one registered handles it wherever it's pressed.
 * Every tab's query editors stay mounted, so Enter in one tab's filter ran
 * the newest tab's query. A context key set only in this editor's own
 * scope makes the binding apply only while this editor has focus.
 */
export function addEditorCommand(
  editor: monaco.editor.IStandaloneCodeEditor,
  keybinding: number,
  handler: () => void,
  when?: string,
) {
  const key = `postgresStudioEditor${++ownKeys}`;
  editor.createContextKey(key, true);
  editor.addCommand(keybinding, handler, when ? `${key} && ${when}` : key);
}
