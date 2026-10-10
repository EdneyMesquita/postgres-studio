import { defaultScript, useConsoleStore } from "../../store/consoleStore";
import { hasUnsavedEdits, useScriptsStore } from "../../store/scriptsStore";
import type { Tab } from "../../store/sessionsStore";

/** Whether a console tab holds edits that aren't saved to its file. */
export function useConsoleDirty(tab: Tab): boolean {
  const script = useConsoleStore((s) =>
    tab.kind === "console" ? (s.consoles[tab.id]?.script ?? null) : null,
  );
  const file = useScriptsStore((s) => (tab.kind === "console" ? s.files[tab.id] : undefined));
  if (tab.kind !== "console") return false;
  const untouched = defaultScript(tab);
  return hasUnsavedEdits(script ?? untouched, file, untouched);
}
