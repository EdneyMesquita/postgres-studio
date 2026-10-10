import { tokenizeSql } from "../../components/console/SqlText";

/** A proposal's tokens on the app's syntax palette (SQL). */
export interface CodeToken {
  text: string;
  className?: string;
}

export function codeTokens(src: string): CodeToken[] {
  return tokenizeSql(src).map((t) => (t.cls ? { text: t.text, className: t.cls } : { text: t.text }));
}
