import { useEffect, useState } from "react";
import { useAssistantStore } from "../../store/assistantStore";

/** How long the green flash after an apply lasts, as in `animate-flash-box`. */
const FLASH_MS = 1200;

/** Which of the tab's query fields the Assistant just wrote, for 1.2s. */
export function useAssistantFlash(tabId: string): "filter" | "pipeline" | null {
  const flash = useAssistantStore((s) => (s.flash?.tabId === tabId ? s.flash : null));
  const [live, setLive] = useState<typeof flash>(null);
  useEffect(() => {
    if (!flash) return;
    setLive(flash);
    const timer = window.setTimeout(() => setLive(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  return live?.field ?? null;
}
