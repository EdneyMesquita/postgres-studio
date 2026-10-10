import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AGENT_NAMES, modelLabel, selectCurrentSession, useAssistantStore } from "../../store/assistantStore";
import type { AgentKind } from "../../types/assistant";

const Tick = ({ on }: { on: boolean }) => (on ? <Check className="size-3.5" /> : <span className="w-3.5" />);

/** Which CLI, and which of its models, answers the next message. */
export function AgentPicker() {
  const agent = useAssistantStore((s) => s.agent);
  const agents = useAssistantStore((s) => s.agents);
  const choice = useAssistantStore((s) => s.modelChoice[s.agent]);
  const setAgent = useAssistantStore((s) => s.setAgent);
  const setModel = useAssistantStore((s) => s.setModel);
  const openPanel = useAssistantStore((s) => s.openPanel);
  const detect = useAssistantStore((s) => s.detect);
  const detected = agents?.find((a) => a.id === agent);
  const model = modelLabel(agent, agents, choice);
  const defaultName = detected?.models.find((m) => m.id === detected.defaultModel)?.name ?? detected?.defaultModel;
  const custom = choice.model !== null && !detected?.models.some((m) => m.id === choice.model);

  const mentionSwitch = (what: string) => {
    const session = selectCurrentSession(useAssistantStore.getState());
    if (session?.messages.length) toast(`Next messages go to ${what}`, { description: "It gets this session's transcript as context" });
  };

  function chooseAgent(next: AgentKind) {
    if (next === agent) return;
    setAgent(next);
    mentionSwitch(AGENT_NAMES[next]);
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && !agents && void detect()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={detected?.version ? `${AGENT_NAMES[agent]} ${detected.version}` : AGENT_NAMES[agent]}
          className="inline-flex h-6 min-w-0 items-center gap-[5px] rounded-md px-1.5 text-sm whitespace-nowrap text-fg-2 hover:bg-hover hover:text-fg aria-expanded:bg-hover"
        >
          <span className="truncate">
            {AGENT_NAMES[agent]}
            {model && <span className="text-fg-3"> · {model}</span>}
          </span>
          <ChevronDown className="size-3 shrink-0 text-fg-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="max-h-[70vh] min-w-60 overflow-y-auto">
        <DropdownMenuLabel>Agent on this machine</DropdownMenuLabel>
        {(["claude", "codex"] as const).map((id) => {
          const found = agents?.find((a) => a.id === id);
          return (
            <DropdownMenuItem key={id} disabled={agents !== null && !found?.path} onSelect={() => chooseAgent(id)}>
              <Tick on={agent === id} />
              <span className="flex-1">{AGENT_NAMES[id]}</span>
              <span className="font-mono text-xs text-fg-3">{found?.version ?? (agents && !found?.path ? "not found" : "")}</span>
            </DropdownMenuItem>
          );
        })}
        {detected?.path && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => {
                setModel(agent, null);
                mentionSwitch(`${AGENT_NAMES[agent]}'s default model`);
              }}
            >
              <Tick on={choice.model === null} />
              <span className="flex-1">Default</span>
              {defaultName && <span className="text-xs text-fg-3">{defaultName}</span>}
            </DropdownMenuItem>
            {detected.models.map((m) => (
              <DropdownMenuItem
                key={m.id}
                onSelect={() => {
                  setModel(agent, m.id);
                  mentionSwitch(m.name);
                }}
              >
                <Tick on={choice.model === m.id} />
                <span className="flex-1">{m.name}</span>
              </DropdownMenuItem>
            ))}
            {custom && (
              <DropdownMenuItem onSelect={() => openPanel("setup")}>
                <Tick on />
                <span className="flex-1 font-mono text-xs">{choice.model}</span>
              </DropdownMenuItem>
            )}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openPanel("setup")}>
          <SlidersHorizontal className="size-3.5" />
          Assistant settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
