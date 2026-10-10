import { memo, useMemo } from "react";
import type { ReactNode } from "react";
import { AGENT_NAMES, useAssistantStore } from "../../store/assistantStore";
import type { AssistantMessage, AssistantSession } from "../../store/assistantStore";
import { parseAnswer } from "../../lib/assistant/answer";
import { ApprovalCard } from "./ApprovalCard";
import { CodeBlock } from "./CodeBlock";
import { ProposalCard } from "./ProposalCard";
import { Prose } from "./Prose";
import { StepList } from "./StepRow";

type AgentTurn = Extract<AssistantMessage, { role: "agent" }>;

function TextPart({ session, cardPrefix, text }: { session: AssistantSession; cardPrefix: string; text: string }) {
  const blocks = useMemo(() => parseAnswer(text), [text]);
  return blocks.map((block, i): ReactNode => {
    if (block.kind === "prose") return <Prose key={i} text={block.text} />;
    if (block.kind === "proposal") {
      return <ProposalCard key={i} session={session} cardId={`${cardPrefix}:${i}`} proposal={block.proposal} />;
    }
    return (
      <div key={i} className="overflow-hidden rounded-md border border-line bg-editor">
        <CodeBlock code={block.code} />
      </div>
    );
  });
}

/** Who answered: the agent, and the model when known. */
function Who({ message }: { message: AgentTurn }) {
  return (
    <div className="-mb-0.5 text-2xs text-fg-3">
      {AGENT_NAMES[message.agent]}
      {message.model && ` · ${message.model}`}
    </div>
  );
}

/** The agent's turn: its steps, its words, its proposals, in the order they came. */
export const AgentMessage = memo(function AgentMessage({
  session,
  message,
}: {
  session: AssistantSession;
  message: AgentTurn;
}) {
  const empty = message.parts.length === 0 && !message.error && !message.stopped;
  if (empty && !message.done) {
    return <Who message={message} />;
  }
  return (
    <div className="flex flex-col gap-2 leading-[1.55]">
      <Who message={message} />
      {message.parts.map((part, i) => {
        if (part.kind === "steps") return <StepList key={i} steps={part.steps} />;
        if (part.kind === "approval") {
          return (
            <ApprovalCard key={part.requestId} approval={part} agent={message.agent} connectionName={session.connectionName} />
          );
        }
        return <TextPart key={part.blockId} session={session} cardPrefix={`${message.id}:${part.blockId}`} text={part.text} />;
      })}
      {message.stopped && <p className="m-0 text-fg-3">Stopped. Nothing was changed.</p>}
      {message.error && (
        <p role="alert" className="m-0 text-sm break-words text-danger">
          {message.error}
          {/\bmodel\b/i.test(message.error) && (
            <>
              {" "}
              <button
                type="button"
                className="font-medium text-accent-text hover:underline hover:underline-offset-2"
                onClick={() => useAssistantStore.getState().openPanel("setup")}
              >
                Choose another model
              </button>
            </>
          )}
        </p>
      )}
      {message.done && empty && !message.stopped && !message.error && (
        <p className="m-0 text-fg-3">No answer came back.</p>
      )}
    </div>
  );
});
