import { memo, useMemo } from "react";
import { codeTokens } from "../../lib/assistant/codeTokens";
import { cn } from "@/lib/utils";

/** A proposal's code on the syntax palette, 12px mono, scrolling past 250px. */
export const CodeBlock = memo(function CodeBlock({ code, className }: { code: string; className?: string }) {
  const tokens = useMemo(() => codeTokens(code), [code]);
  return (
    <pre
      className={cn(
        "m-0 max-h-[250px] overflow-auto px-2.5 py-2 font-mono text-xs leading-[18px] whitespace-pre text-fg [font-variant-ligatures:none] [tab-size:2]",
        className,
      )}
    >
      {tokens.map((t, i) =>
        t.className ? (
          <span key={i} className={t.className}>
            {t.text}
          </span>
        ) : (
          t.text
        ),
      )}
    </pre>
  );
});
