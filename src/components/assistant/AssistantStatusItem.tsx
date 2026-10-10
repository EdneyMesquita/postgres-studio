import { Loader2, Sparkles } from "lucide-react";
import { AGENT_NAMES, modelLabel, selectCurrentSession, useAssistantStore } from "../../store/assistantStore";

/** The status bar's note of the agent: which one, and whether it's working. */
export function AssistantStatusItem() {
  const enabled = useAssistantStore((s) => s.enabled);
  const agent = useAssistantStore((s) => s.agent);
  const togglePanel = useAssistantStore((s) => s.togglePanel);
  const model = useAssistantStore((s) => modelLabel(s.agent, s.agents, s.modelChoice[s.agent]));
  const session = useAssistantStore(selectCurrentSession);
  if (!enabled) return null;
  const running = session?.running ?? false;
  const waiting = session?.waiting ?? false;
  return (
    <button
      type="button"
      onClick={() => togglePanel()}
      title="Assistant (Ctrl L)"
      className="inline-flex h-[22px] items-center gap-1.5 rounded-sm px-[7px] whitespace-nowrap hover:bg-hover hover:text-fg"
    >
      {running && !waiting ? (
        <Loader2 className="size-3 animate-spin text-accent-text" />
      ) : (
        <Sparkles className="size-3 text-accent-text" />
      )}
      <span>
        {AGENT_NAMES[agent]}
        {model && ` · ${model}`}
      </span>
      {running && <span className="text-fg-3">{waiting ? "waiting for you" : "working"}</span>}
    </button>
  );
}
