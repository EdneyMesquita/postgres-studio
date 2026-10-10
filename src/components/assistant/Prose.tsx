import { memo } from "react";
import type { ReactNode } from "react";

/** Inline marks the agents use: `code` and **bold**. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((piece, i) => {
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      return (
        <code key={i} className="rounded-[3px] bg-fg/8 px-1 py-px font-mono text-xs text-fg [font-variant-ligatures:none]">
          {piece.slice(1, -1)}
        </code>
      );
    }
    if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) {
      return (
        <strong key={i} className="font-semibold text-fg">
          {piece.slice(2, -2)}
        </strong>
      );
    }
    return piece;
  });
}

/**
 * The agent's words: paragraphs and lists with inline code, nothing else.
 * Never HTML: whatever the agent writes is shown as text.
 */
export const Prose = memo(function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const list = lines.every((l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l));
        if (list) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const Tag = ordered ? "ol" : "ul";
          return (
            <Tag key={i} className={`m-0 flex flex-col gap-0.5 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={i} className="m-0 whitespace-pre-wrap">
            {inline(block.replace(/^#+\s+/gm, ""))}
          </p>
        );
      })}
    </>
  );
});
