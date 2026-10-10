import { memo } from "react";
import type { AssistantMessage } from "../../store/assistantStore";
import { ContextChipIcon } from "./ContextChips";

type UserTurn = Extract<AssistantMessage, { role: "user" }>;

/** What the user asked, and what they attached to it. */
export const UserMessage = memo(function UserMessage({ message }: { message: UserTurn }) {
  return (
    <div className="rounded-md bg-fg/7 px-2.5 py-2 leading-normal break-words whitespace-pre-wrap">
      {message.text}
      {message.context.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 whitespace-normal">
          {message.context.map((c) => (
            <span key={c.id} className="inline-flex h-[22px] items-center gap-[5px] rounded-sm bg-fg/7 px-[7px] text-xs text-fg-2">
              <ContextChipIcon kind={c.kind} />
              {c.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
