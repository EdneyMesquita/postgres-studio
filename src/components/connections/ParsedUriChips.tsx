import { useMemo } from "react";
import { describeConnectionUri } from "@/lib/connectionUri";

/** What the connection string says - hosts, user, TLS... - as small chips. */
export function ParsedUriChips({ uri }: { uri: string }) {
  const facts = useMemo(() => describeConnectionUri(uri), [uri]);
  if (facts.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Read from the connection string">
      {facts.map((fact) => (
        <li
          key={fact.label}
          className="inline-flex h-[22px] max-w-full min-w-0 items-center gap-1.5 rounded-sm bg-fg/6 px-2 text-xs text-fg-2"
        >
          {fact.label}
          {fact.value && (
            <b className="truncate font-mono font-medium text-fg [font-variant-ligatures:none]">
              {fact.value}
            </b>
          )}
          {fact.suffix}
        </li>
      ))}
    </ul>
  );
}
