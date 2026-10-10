import { Button } from "@/components/ui/button";
import { selectCurrentSession, useAssistantStore } from "../../store/assistantStore";
import { selectActiveTab, useSessionsStore } from "../../store/sessionsStore";
import { AssistantHeader } from "./AssistantHeader";
import { Composer } from "./Composer";
import { ContextRow } from "./ContextRow";
import { EmptySession } from "./EmptySession";
import { MessageLog } from "./MessageLog";
import { SessionNotice } from "./SessionNotice";
import { WorkingLine } from "./WorkingLine";

/** The conversation view: where it reads, what was said, the message box. */
export function AssistantChat() {
  const session = useAssistantStore(selectCurrentSession);
  const newSession = useAssistantStore((s) => s.newSession);
  const tab = useSessionsStore(selectActiveTab);
  if (!session) {
    return (
      <>
        <AssistantHeader />
        <div className="flex flex-1 flex-col items-start gap-3 border-t border-line-soft px-3.5 py-4 text-sm leading-normal text-fg-2">
          <p className="m-0">The Assistant works on one database at a time: open a table or a console, then ask about it here.</p>
          {tab && (
            <Button onClick={newSession}>
              Start a session on {tab.database}
            </Button>
          )}
        </div>
      </>
    );
  }
  return (
    <>
      <AssistantHeader />
      <ContextRow session={session} />
      <SessionNotice session={session} />
      {session.messages.length === 0 ? <EmptySession session={session} /> : <MessageLog session={session} />}
      <WorkingLine session={session} />
      <Composer session={session} />
    </>
  );
}
