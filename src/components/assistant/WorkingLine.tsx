import { useEffect, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { AGENT_NAMES } from "../../store/assistantStore";
import type { AssistantSession } from "../../store/assistantStore";

/** Under the log while a turn runs: working, and for how long, or waiting on the user. */
export function WorkingLine({ session }: { session: AssistantSession }) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = session.running && !session.waiting;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [ticking]);

  if (!session.running) return null;
  const seconds = session.turnStartedAt ? Math.max(0, Math.floor((now - session.turnStartedAt) / 1000)) : 0;
  return (
    <div role="status" className="flex flex-none items-center gap-[7px] px-3 pb-1.5 text-xs text-fg-2">
      {session.waiting ? (
        <>
          <Info className="size-3 text-accent-text" />
          Waiting for your answer above
        </>
      ) : (
        <>
          <Loader2 className="size-3 animate-spin text-accent-text" />
          {AGENT_NAMES[session.agent]} is working
          <span className="text-fg-3 tabular-nums">{seconds} s</span>
        </>
      )}
    </div>
  );
}
