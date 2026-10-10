import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AGENT_NAMES, isValidModelName, useAssistantStore } from "../../store/assistantStore";
import type { AgentKind, DetectedAgent } from "../../types/assistant";

const DEFAULT = "__default";
const OTHER = "__other";

/**
 * Which model the agent runs and how hard it thinks: the CLI's own setting
 * by default, one of the models it lists, or any model name. Cheaper and
 * faster for simple filters, stronger for complex work - the user decides.
 * Keyed by agent where it's used, so switching agents starts it afresh.
 */
export function ModelSettings({ agent, detected }: { agent: AgentKind; detected: DetectedAgent }) {
  const choice = useAssistantStore((s) => s.modelChoice[agent]);
  const setModel = useAssistantStore((s) => s.setModel);
  const setEffort = useAssistantStore((s) => s.setEffort);
  const modelId = useId();
  const effortId = useId();
  const otherId = useId();
  const known = detected.models.find((m) => m.id === choice.model);
  const isOther = choice.model !== null && !known;
  const [otherOpen, setOtherOpen] = useState(isOther);
  const [draft, setDraft] = useState(isOther ? (choice.model ?? "") : "");
  const invalid = draft.trim() !== "" && !isValidModelName(draft.trim());

  const defaultModel = detected.models.find((m) => m.id === detected.defaultModel)?.name ?? detected.defaultModel;
  const model = known ?? (choice.model === null ? detected.models.find((m) => m.id === detected.defaultModel) : undefined);
  const efforts = model?.efforts.length ? model.efforts : detected.efforts;
  const defaultEffort = choice.model === null ? detected.defaultEffort ?? model?.defaultEffort : model?.defaultEffort;
  const modelValue = otherOpen ? OTHER : (choice.model ?? DEFAULT);
  const modelShown =
    modelValue === DEFAULT ? `Default · ${defaultModel ?? `${AGENT_NAMES[agent]}'s own`}` : modelValue === OTHER ? "Other model…" : known?.name;

  function commitOther() {
    const name = draft.trim();
    if (!name) setModel(agent, null);
    else if (isValidModelName(name)) setModel(agent, name);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_128px] gap-2">
        <div className="min-w-0">
          <Select
            value={modelValue}
            onValueChange={(value) => {
              if (value === OTHER) {
                setOtherOpen(true);
                return;
              }
              setOtherOpen(false);
              setDraft("");
              setModel(agent, value === DEFAULT ? null : value);
            }}
          >
            <SelectTrigger id={modelId} aria-label="Model" className="w-full min-w-0">
              <SelectValue>{modelShown}</SelectValue>
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-80">
              <SelectItem value={DEFAULT}>
                Default{defaultModel ? ` · ${defaultModel}` : ""}
              </SelectItem>
              {detected.models.length > 0 && <SelectSeparator />}
              {detected.models.map((m) => (
                <SelectItem key={m.id} value={m.id} className="h-auto min-h-7 py-1">
                  <span className="flex flex-col items-start gap-0">
                    <span>{m.name}</span>
                    {m.description && <span className="text-xs text-fg-3 [[data-highlighted]_&]:text-current">{m.description}</span>}
                  </span>
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value={OTHER}>Other model…</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0">
          <Select value={choice.effort ?? DEFAULT} onValueChange={(value) => setEffort(agent, value === DEFAULT ? null : value)}>
            <SelectTrigger id={effortId} aria-label="Effort" className="w-full min-w-0">
              <SelectValue>
                <span className="truncate">
                  <span className="text-fg-3">Effort </span>
                  {choice.effort ?? defaultEffort ?? "default"}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value={DEFAULT}>Default{defaultEffort ? ` · ${defaultEffort}` : ""}</SelectItem>
              <SelectSeparator />
              {efforts.map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {otherOpen && (
        <div className="flex flex-col gap-1">
          <label htmlFor={otherId} className="sr-only">
            Model name
          </label>
          <Input
            id={otherId}
            autoFocus
            value={draft}
            aria-invalid={invalid}
            placeholder={agent === "claude" ? "Any model name, e.g. claude-sonnet-5" : "Any model name, e.g. gpt-6-luna"}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitOther}
            onKeyDown={(e) => e.key === "Enter" && commitOther()}
            className="font-mono text-data [font-variant-ligatures:none]"
          />
          {invalid && <span className="text-xs text-danger">Letters, digits and . _ : / [ ] - @ only.</span>}
        </div>
      )}
      <p className="m-0 text-sm leading-normal text-fg-3">
        {detected.defaultModel
          ? `Default follows your ${AGENT_NAMES[agent]} setting. `
          : `Default is whatever ${AGENT_NAMES[agent]} picks. `}
        A faster, cheaper model is enough for most conditions; a stronger one or more effort helps with joins,
        window functions and multi-statement SQL. Applies from the next message.
      </p>
    </div>
  );
}
