import { toast } from "sonner";
import { useAssistantStore } from "../../store/assistantStore";
import type { AssistantSession } from "../../store/assistantStore";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useConsoleStore } from "../../store/consoleStore";
import { tabIdFor, useSessionsStore } from "../../store/sessionsStore";
import type { TabConnection } from "../../store/sessionsStore";
import { useUiStore } from "../../store/uiStore";
import type { Proposal } from "../../lib/assistant/answer";

/** The connection as a tab shows it, from its saved profile. */
function tabConnection(session: AssistantSession): TabConnection {
  const profile = useConnectionsStore.getState().profiles.find((p) => p.id === session.connectionId);
  return { id: session.connectionId, name: session.connectionName, summary: profile?.summary ?? "" };
}

/** The table (schema.table) a condition goes into. */
export function proposalTable(session: AssistantSession, proposal: Proposal): string | null {
  return proposal.table ?? session.table;
}

/** "schema.table" or "table" (public). */
export function splitTable(qualified: string): { schema: string; table: string } {
  const dot = qualified.indexOf(".");
  return dot < 0 ? { schema: "public", table: qualified } : { schema: qualified.slice(0, dot), table: qualified.slice(dot + 1) };
}

/**
 * Puts a WHERE condition into its table's tab - opening the tab if needed -
 * and runs it. The tab's previous condition is kept for Undo.
 */
export async function applyToQuery(session: AssistantSession, cardId: string, proposal: Proposal) {
  const qualified = proposalTable(session, proposal);
  const live = useConnectionsStore.getState().sessions[session.connectionId];
  if (!qualified || !live) {
    toast.error(live ? "The proposal doesn't name its table" : `${session.connectionName} is not connected`);
    return;
  }
  const { schema, table } = splitTable(qualified);
  const sessions = useSessionsStore.getState();
  const id = tabIdFor(session.connectionId, session.database, schema, table);
  if (!sessions.tabs.some((t) => t.id === id)) {
    await sessions.openTable(live.sessionId, tabConnection(session), session.database, schema, table, "r");
  } else sessions.activateTab(id);
  const tab = useSessionsStore.getState().tabs.find((t) => t.id === id);
  if (!tab || tab.kind !== "table") return;
  useUiStore.getState().setMainTab(id, "data");
  useAssistantStore.getState().markApplied(cardId, { kind: "query", tabId: id, previous: { whereText: tab.whereText } });
  useSessionsStore.getState().applyWhere(id, proposal.code);
  useAssistantStore.setState({ flash: { tabId: id, field: "filter", at: Date.now() } });
  await useSessionsStore.getState().runQuery(live.sessionId, id);
}

/** Puts the tab's condition back the way it was before the proposal. */
export async function undoApplied(session: AssistantSession, cardId: string) {
  const applied = session.applied[cardId];
  if (applied?.kind !== "query") return;
  useAssistantStore.getState().unmarkApplied(cardId);
  const sessions = useSessionsStore.getState();
  if (!sessions.tabs.some((t) => t.id === applied.tabId)) return;
  sessions.updateTab(applied.tabId, { whereText: applied.previous.whereText, offset: 0 });
  sessions.activateTab(applied.tabId);
  const live = useConnectionsStore.getState().sessions[session.connectionId];
  if (live) await useSessionsStore.getState().runQuery(live.sessionId, applied.tabId);
}

/** The SQL a proposal becomes in a console: SQL as it is, conditions as a SELECT. */
export function consoleScriptFor(session: AssistantSession, proposal: Proposal): string {
  if (proposal.kind === "script") return proposal.code.replace(/\s+$/, "") + "\n";
  const qualified = proposalTable(session, proposal) ?? "public.table";
  return `-- Written by the Assistant\nSELECT *\nFROM ${qualified}\nWHERE ${proposal.code}\nLIMIT 100;\n`;
}

/** Opens a new console on the session's database with the proposal in it, not run. */
export function openInConsole(session: AssistantSession, cardId: string, proposal: Proposal) {
  const id = useSessionsStore.getState().openConsole(tabConnection(session), session.database, { fromAssistant: true });
  useConsoleStore.getState().setScript(id, consoleScriptFor(session, proposal));
  if (proposal.kind === "script") useAssistantStore.getState().markApplied(cardId, { kind: "console", tabId: id });
}

export function copyProposal(proposal: Proposal) {
  const what = proposal.kind === "script" ? "SQL" : "condition";
  navigator.clipboard.writeText(proposal.code).then(
    () => toast.success(`Copied the ${what}`, { description: "Paste it anywhere; nothing ran" }),
    (e) => toast.error(`Couldn't copy the ${what}`, { description: String(e) }),
  );
}
