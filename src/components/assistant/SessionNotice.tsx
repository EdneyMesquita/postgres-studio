import { isConnectionAllowed, useAssistantStore } from "../../store/assistantStore";
import type { AssistantSession } from "../../store/assistantStore";
import { selectActiveTab, useSessionsStore } from "../../store/sessionsStore";

/**
 * Said when the tab in view isn't what the session reads: another server
 * or database, or a connection not shared with the Assistant.
 */
export function SessionNotice({ session }: { session: AssistantSession }) {
  const tab = useSessionsStore(selectActiveTab);
  // re-evaluated when access changes
  useAssistantStore((s) => s.access);
  const openPanel = useAssistantStore((s) => s.openPanel);
  const newSession = useAssistantStore((s) => s.newSession);
  if (!tab) return null;

  const box = "mx-2 mb-2 flex-none rounded-md bg-fg/5 px-2.5 py-2 text-sm leading-[1.45] text-fg-2";
  const link = "mt-1 inline-block font-medium text-accent-text hover:underline hover:underline-offset-2";
  if (!isConnectionAllowed(tab.connection.id)) {
    return (
      <div className={box}>
        <b className="font-medium text-fg">{tab.connection.name}</b> is not shared with the Assistant, so it can't read
        this tab.
        <br />
        <button type="button" className={link} onClick={() => openPanel("setup")}>
          Change in Assistant settings
        </button>
      </div>
    );
  }
  if (tab.connection.id === session.connectionId && tab.database === session.database) return null;
  const viewing = tab.kind === "table" ? `${tab.database}.${tab.schema}.${tab.table}` : tab.database;
  return (
    <div className={box}>
      You're viewing{" "}
      <b className="font-medium text-fg">
        {viewing} on {tab.connection.name}
      </b>
      ; this session reads {session.database} on {session.connectionName}.
      <br />
      <button type="button" className={link} onClick={newSession}>
        Start a session on {tab.database}
      </button>
    </div>
  );
}
