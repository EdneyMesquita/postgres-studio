import { useState } from "react";
import { AlertCircle, Check, ChevronRight, CircleX, Loader2 } from "lucide-react";
import type { AssistantStep } from "../../store/assistantStore";
import { cn } from "@/lib/utils";

/**
 * One tool call the agent made through the app: what it read and what came
 * back. Expands to the call as made.
 */
export function StepRow({ step }: { step: AssistantStep }) {
  const [open, setOpen] = useState(false);
  const icon =
    step.state === "run" ? (
      <Loader2 className="size-3.5 animate-spin text-fg-3" />
    ) : step.state === "denied" ? (
      <CircleX className="size-3.5 text-fg-3" />
    ) : step.state === "error" ? (
      <AlertCircle className="size-3.5 text-danger" />
    ) : (
      <Check className="size-3.5 text-ok" />
    );
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-6 w-full items-center gap-[7px] rounded-sm px-1.5 py-0.5 text-left text-sm text-fg-2 hover:bg-hover hover:text-fg"
      >
        {icon}
        <span className="min-w-0 truncate">{step.state === "run" ? `${step.label}…` : step.label}</span>
        <span className={cn("min-w-0 flex-1 truncate text-fg-3", step.state === "error" && "text-danger")}>
          {step.state === "run" ? "" : step.meta}
        </span>
        <ChevronRight
          className={cn("size-3 shrink-0 text-fg-3 transition-transform duration-150", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="mx-1.5 mt-0.5 mb-1.5 ml-[27px] rounded-sm border border-line-soft bg-editor px-2 py-1.5 font-mono text-[11.5px] leading-[17px] break-words whitespace-pre-wrap text-fg-2 [font-variant-ligatures:none]">
          <span className="text-json-bson">postgres_studio.{step.call}</span>
          {step.out ? `\n→ ${step.out}` : ""}
        </div>
      )}
    </>
  );
}

export function StepList({ steps }: { steps: AssistantStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="-mx-1.5 flex flex-col">
      {steps.map((step) => (
        <StepRow key={step.stepId} step={step} />
      ))}
    </div>
  );
}
