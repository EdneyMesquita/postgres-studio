import { useLayoutEffect, useRef } from "react";
import type { AssistantSession } from "../../store/assistantStore";
import { AgentMessage } from "./AgentMessage";
import { UserMessage } from "./UserMessage";

/** Within this many px of the bottom, new content keeps the log pinned there. */
const STICK = 48;

/** The conversation, following new steps and text while the user is at its end. */
export function MessageLog({ session }: { session: AssistantSession }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const sessionId = session.id;

  // A session opens at its latest message.
  useLayoutEffect(() => {
    pinned.current = true;
  }, [sessionId]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      ref={ref}
      role="log"
      aria-label="Assistant conversation"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK;
      }}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-t border-line-soft px-3 pt-1.5 pb-4"
    >
      {session.messages.map((m) =>
        m.role === "user" ? (
          <UserMessage key={m.id} message={m} />
        ) : (
          <AgentMessage key={m.id} session={session} message={m} />
        ),
      )}
    </div>
  );
}
