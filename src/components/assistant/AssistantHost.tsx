import { lazy, Suspense } from "react";
import { useAssistantStore } from "../../store/assistantStore";

const AssistantPanel = lazy(() => import("./AssistantPanel"));

/** Mounts the Assistant panel while it's open. */
export function AssistantHost() {
  const open = useAssistantStore((s) => s.panel !== null);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <AssistantPanel />
    </Suspense>
  );
}
