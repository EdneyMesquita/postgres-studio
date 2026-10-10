import type * as Monaco from "monaco-editor";

/** What Run takes from the editor: the selection, or the caret's statement. */
export interface RunRequest {
  /** The text to send: the selection, or the whole script. */
  sql: string;
  /** With the whole script, the caret's character offset (only that statement runs); null runs everything. */
  caret: number | null;
  /** Where `sql` starts in the editor, for mapping error positions back. */
  from: number;
}

/** Reads the run request off an editor: its selection, else the caret's statement. */
export function runRequestOf(editor: Monaco.editor.IStandaloneCodeEditor, all = false): RunRequest | null {
  const model = editor.getModel();
  if (!model) return null;
  const selection = editor.getSelection();
  if (!all && selection && !selection.isEmpty()) {
    return { sql: model.getValueInRange(selection), caret: null, from: model.getOffsetAt(selection.getStartPosition()) };
  }
  const position = editor.getPosition();
  return { sql: model.getValue(), caret: all || !position ? null : model.getOffsetAt(position), from: 0 };
}
