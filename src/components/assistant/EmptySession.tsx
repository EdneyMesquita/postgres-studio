import { AGENT_NAMES, useAssistantStore } from "../../store/assistantStore";
import type { AssistantSession } from "../../store/assistantStore";

/** A new session: what the agent can do here, and three places to start. */
export function EmptySession({ session }: { session: AssistantSession }) {
  const setDraft = useAssistantStore((s) => s.setDraft);
  const agent = useAssistantStore((s) => s.agent);
  const where = session.table ? `${session.database}.${session.table}` : session.database;
  const noun = session.table ?? "rows";
  const suggestions = [
    `Count ${noun} per day for the last week`,
    `Find duplicate or missing values in ${noun}`,
    `Write a script that archives ${noun} older than 90 days`,
  ];

  function pick(text: string) {
    setDraft(text);
    const input = document.getElementById("assistant-input") as HTMLTextAreaElement | null;
    input?.focus();
    input?.setSelectionRange(text.length, text.length);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto border-t border-line-soft px-3.5 py-4">
      <h3 className="m-0 text-base font-semibold">Ask about {where}</h3>
      <p className="m-0 mb-1 text-sm leading-normal text-fg-2">
        {AGENT_NAMES[agent]} reads the schema, indexes and plans of {session.connectionName} through read-only tools,
        then writes the condition or SQL. You decide what runs.
      </p>
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => pick(text)}
          className="w-full rounded-md border border-line bg-editor px-2.5 py-[7px] text-left text-sm leading-normal hover:border-field-line hover:bg-row-hover"
        >
          {text}
        </button>
      ))}
    </div>
  );
}
