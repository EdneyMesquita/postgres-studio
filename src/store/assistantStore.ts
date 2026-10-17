import { create } from "zustand";
import { persist } from "zustand/middleware";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/tauri";
import { firstProposal } from "../lib/assistant/answer";
import { useConnectionsStore } from "./connectionsStore";
import { selectActiveTab, useSessionsStore } from "./sessionsStore";
import type { TabConnection } from "./sessionsStore";
import { defaultScript, useConsoleStore } from "./consoleStore";
import { useUiStore } from "./uiStore";
import type {
  AgentKind,
  ApprovalChoice,
  AssistantApprovalEvent,
  AssistantEvent,
  AssistantStepEvent,
  DetectedAgent,
  ModelChoice,
} from "../types/assistant";

export const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };
export const AGENT_PROVIDERS: Record<AgentKind, string> = { claude: "Anthropic", codex: "OpenAI" };

export type AssistantStep = Omit<AssistantStepEvent, "agentSessionId">;
export type AssistantApproval = Omit<AssistantApprovalEvent, "agentSessionId">;

export type AgentPart =
  | { kind: "steps"; steps: AssistantStep[] }
  | { kind: "text"; blockId: string; text: string; done: boolean }
  | ({ kind: "approval" } & AssistantApproval);

/** Something the user attached to a message: a condition, a row, a result. */
export interface ContextItem {
  id: string;
  kind: "filter" | "row" | "result" | "table";
  label: string;
  content: string;
}

export type AssistantMessage =
  | { id: string; role: "user"; text: string; context: ContextItem[] }
  | {
      id: string;
      role: "agent";
      agent: AgentKind;
      /** The model it answered with, as shown ("Sonnet"), when known. */
      model: string | null;
      parts: AgentPart[];
      error: string | null;
      stopped: boolean;
      done: boolean;
    };

/** A proposal already used: applied to a tab's query, or opened in a console. */
export type AppliedProposal =
  | {
      kind: "query";
      tabId: string;
      previous: { whereText: string };
    }
  | { kind: "console"; tabId: string };

/** One conversation, bound to a database of a connection. */
export interface AssistantSession {
  id: string;
  agent: AgentKind;
  connectionId: string;
  connectionName: string;
  database: string;
  /** The table the session started from (schema.table); the one it reads first. */
  table: string | null;
  title: string;
  createdAt: number;
  messages: AssistantMessage[];
  /** The backend's session, once a message was sent. */
  agentSessionId: string | null;
  /** The app session it was started on; a reconnect needs a new one. */
  appSessionId: string | null;
  /** The CLI's own session id, to resume it. */
  cliSessionId: string | null;
  /** The model choice the backend session was started with. */
  runsWith: string | null;
  running: boolean;
  /** A tool waits for the user to allow reading row values. */
  waiting: boolean;
  turnStartedAt: number | null;
  applied: Record<string, AppliedProposal>;
}

/** Ctrl+I in a WHERE field or a console. */
export interface InlineAsk {
  tabId: string;
  kind: "filter" | "script";
  state: "ask" | "working" | "review" | "error";
  prompt: string;
  /** The condition or SQL when the ask was sent. */
  original: string;
  proposal: string | null;
  table: string | null;
  /** The step the agent is on, while working. */
  step: string | null;
  approval: AssistantApproval | null;
  error: string | null;
  agentSessionId: string | null;
  text: string;
}

type PanelView = "chat" | "setup";

interface Settings {
  /** Set once the user finished setup: the Assistant is opt-in. */
  enabled: boolean;
  agent: AgentKind;
  share: { indexes: boolean; values: boolean };
  /** Connections allowed or not; unset ones follow `defaultAccess`. */
  access: Record<string, boolean>;
  /** Connections where row values are always allowed. */
  valuesConnections: string[];
  /** The model and effort per agent; null keeps the CLI's own setting. */
  modelChoice: Record<AgentKind, ModelChoice>;
  panelWidth: number;
}

interface AssistantState extends Settings {
  panel: PanelView | null;
  agents: DetectedAgent[] | null;
  detecting: boolean;
  sessions: AssistantSession[];
  currentId: string | null;
  draft: string;
  context: ContextItem[];
  inline: Record<string, InlineAsk>;
  /** The tab and field a proposal was just applied to, for the flash. */
  flash: { tabId: string; field: "filter" | "pipeline"; at: number } | null;

  detect: () => Promise<void>;
  openPanel: (view?: PanelView) => void;
  closePanel: () => void;
  togglePanel: () => void;
  setAgent: (agent: AgentKind) => void;
  setShare: (key: "indexes" | "values", on: boolean) => void;
  /** Allows or denies several connections at once, e.g. a whole folder. */
  setAccess: (connectionIds: string[], allowed: boolean) => void;
  setModel: (agent: AgentKind, model: string | null) => void;
  setEffort: (agent: AgentKind, effort: string | null) => void;
  setPanelWidth: (width: number) => void;
  /** Ends setup: the Assistant is on from here. */
  enable: () => void;
  /** Turns it off (Settings): stops what runs and closes the panel. */
  disable: () => void;
  newSession: () => void;
  selectSession: (id: string) => void;
  clearSession: () => void;
  setDraft: (text: string) => void;
  addContext: (item: Omit<ContextItem, "id">) => void;
  removeContext: (id: string) => void;
  send: () => Promise<void>;
  stop: () => Promise<void>;
  answerApproval: (requestId: string, choice: ApprovalChoice) => Promise<void>;
  markApplied: (cardId: string, applied: AppliedProposal) => void;
  unmarkApplied: (cardId: string) => void;

  askInline: () => void;
  setInlinePrompt: (tabId: string, prompt: string) => void;
  generateInline: (tabId: string) => Promise<void>;
  acceptInline: (tabId: string) => void;
  closeInline: (tabId: string) => void;
  continueInline: (tabId: string) => void;
}

export const DEFAULT_ASSISTANT_WIDTH = 380;
const MAX_SESSIONS = 20;

const uid = () => crypto.randomUUID();

/** A model name the CLIs take as one argument (the backend checks it too). */
export function isValidModelName(name: string): boolean {
  return /^[A-Za-z0-9._:/[\]@][A-Za-z0-9._:/[\]@-]{0,99}$/.test(name);
}

/**
 * The model an agent will run, as shown: what the user picked, or the one
 * set up in the CLI itself - by its display name when it's a known model.
 */
export function modelLabel(agent: AgentKind, agents: DetectedAgent[] | null, choice: ModelChoice): string | null {
  const detected = agents?.find((a) => a.id === agent);
  const id = choice.model ?? detected?.defaultModel ?? null;
  if (!id) return null;
  return detected?.models.find((m) => m.id === id)?.name ?? id;
}

const choiceKey = (choice: ModelChoice) => `${choice.model ?? ""}|${choice.effort ?? ""}`;

/** Servers on this machine start allowed; remote ones wait for the user. */
export function defaultAccess(summary: string | undefined): boolean {
  return /(^|[@/,])(localhost|127\.0\.0\.1|\[::1\])(:|\/|,|\?|$)/.test(summary ?? "");
}

/** Whether the Assistant may read this connection. */
export function isConnectionAllowed(connectionId: string): boolean {
  const explicit = useAssistantStore.getState().access[connectionId];
  if (explicit !== undefined) return explicit;
  const profile = useConnectionsStore.getState().profiles.find((p) => p.id === connectionId);
  return defaultAccess(profile?.summary);
}

/** Where the active tab points: the target a new session reads. */
function activeTarget() {
  const tab = selectActiveTab(useSessionsStore.getState());
  if (!tab) return null;
  return {
    connection: tab.connection,
    database: tab.database,
    table: tab.kind === "table" ? `${tab.schema}.${tab.table}` : null,
  };
}

function blankSession(
  agent: AgentKind,
  target: { connection: TabConnection; database: string; table: string | null },
): AssistantSession {
  return {
    id: uid(),
    agent,
    connectionId: target.connection.id,
    connectionName: target.connection.name,
    database: target.database,
    table: target.table,
    title: "New session",
    createdAt: Date.now(),
    messages: [],
    agentSessionId: null,
    appSessionId: null,
    cliSessionId: null,
    runsWith: null,
    running: false,
    waiting: false,
    turnStartedAt: null,
    applied: {},
  };
}

/** Which session or inline ask each backend session id belongs to. */
const routes = new Map<string, { type: "chat"; sessionId: string } | { type: "inline"; tabId: string }>();

/** The attached context, below the user's words, the way the agent gets it. */
function withContext(text: string, context: ContextItem[]): string {
  if (context.length === 0) return text;
  const blocks = context.map((c) => `[${c.label}]\n${c.content}`).join("\n\n");
  return `${text}\n\n---\nAttached by the user:\n${blocks}`;
}

/** What another agent said earlier, for a session that changed agents. */
function transcript(messages: AssistantMessage[]): string {
  const lines: string[] = [];
  for (const m of messages.slice(-8)) {
    if (m.role === "user") lines.push(`User: ${m.text}`);
    else {
      const text = m.parts
        .filter((p) => p.kind === "text")
        .map((p) => (p as { text: string }).text)
        .join("\n");
      if (text) lines.push(`Assistant: ${text}`);
    }
  }
  const joined = lines.join("\n\n");
  return joined.length > 6000 ? joined.slice(-6000) : joined;
}

export const useAssistantStore = create<AssistantState>()(
  persist(
    (set, get) => {
      function current(): AssistantSession | null {
        const { sessions, currentId } = get();
        return sessions.find((s) => s.id === currentId) ?? null;
      }

      function patchSession(id: string, patch: (s: AssistantSession) => Partial<AssistantSession>) {
        set((st) => ({
          sessions: st.sessions.map((s) => (s.id === id ? { ...s, ...patch(s) } : s)),
        }));
      }

      /** Changes the session's last message, the agent's current turn. */
      function patchTurn(
        id: string,
        change: (m: Extract<AssistantMessage, { role: "agent" }>) => Partial<Extract<AssistantMessage, { role: "agent" }>>,
      ) {
        patchSession(id, (s) => {
          const last = s.messages[s.messages.length - 1];
          if (!last || last.role !== "agent") return {};
          return { messages: [...s.messages.slice(0, -1), { ...last, ...change(last) }] };
        });
      }

      function patchInline(tabId: string, patch: Partial<InlineAsk>) {
        set((st) =>
          st.inline[tabId] ? { inline: { ...st.inline, [tabId]: { ...st.inline[tabId], ...patch } } } : st,
        );
      }

      /** The session's backend session, started or restarted as needed. */
      async function ensureBackend(session: AssistantSession): Promise<string> {
        const live = useConnectionsStore.getState().sessions[session.connectionId];
        if (!live) {
          throw new Error(`${session.connectionName} is not connected. Connect it in the Explorer, then send again.`);
        }
        if (!isConnectionAllowed(session.connectionId)) {
          throw new Error(`${session.connectionName} is not shared with the Assistant. Allow it in Assistant settings.`);
        }
        // A new model or effort restarts the CLI on the same conversation.
        const choice = get().modelChoice[session.agent];
        if (
          session.agentSessionId &&
          session.appSessionId === live.sessionId &&
          session.runsWith === choiceKey(choice)
        ) {
          return session.agentSessionId;
        }
        if (session.agentSessionId) {
          routes.delete(session.agentSessionId);
          await api.assistantClose(session.agentSessionId).catch(() => {});
        }
        await listenToAgents();
        const { agentSessionId } = await api.assistantStart({
          agent: session.agent,
          purpose: "chat",
          connectionId: session.connectionId,
          connectionName: session.connectionName,
          sessionId: live.sessionId,
          database: session.database,
          table: session.table,
          serverVersion: live.serverVersion,
          resumeId: session.cliSessionId,
          model: choice.model,
          effort: choice.effort,
        });
        routes.set(agentSessionId, { type: "chat", sessionId: session.id });
        patchSession(session.id, () => ({
          agentSessionId,
          appSessionId: live.sessionId,
          runsWith: choiceKey(choice),
        }));
        return agentSessionId;
      }

      function closeBackend(session: AssistantSession | null) {
        if (!session?.agentSessionId) return;
        routes.delete(session.agentSessionId);
        void api.assistantClose(session.agentSessionId).catch(() => {});
      }

      function startSessionFor(target: ReturnType<typeof activeTarget>) {
        if (!target) return;
        const session = blankSession(get().agent, target);
        set((st) => ({
          sessions: [session, ...st.sessions].slice(0, MAX_SESSIONS),
          currentId: session.id,
          draft: "",
          context: [],
        }));
      }

      return {
        enabled: false,
        agent: "claude",
        share: { indexes: true, values: false },
        access: {},
        valuesConnections: [],
        modelChoice: {
          claude: { model: null, effort: null },
          codex: { model: null, effort: null },
        },
        panelWidth: DEFAULT_ASSISTANT_WIDTH,
        panel: null,
        agents: null,
        detecting: false,
        sessions: [],
        currentId: null,
        draft: "",
        context: [],
        inline: {},
        flash: null,

        detect: async () => {
          set({ detecting: true });
          try {
            const agents = await api.assistantDetect();
            set({ agents, detecting: false });
            // Default to what's installed.
            const found = agents.filter((a) => a.path);
            if (found.length && !found.some((a) => a.id === get().agent)) set({ agent: found[0].id });
          } catch {
            set({ agents: [], detecting: false });
          }
        },

        openPanel: (view) => {
          const next = view ?? (get().enabled ? "chat" : "setup");
          if (next === "chat" && !current()) startSessionFor(activeTarget());
          set({ panel: next });
          // What's installed, and which models it runs, for the setup and the labels.
          if (!get().agents && !get().detecting) void get().detect();
        },
        closePanel: () => set({ panel: null }),
        togglePanel: () => (get().panel ? get().closePanel() : get().openPanel()),

        setAgent: (agent) => set({ agent }),
        setShare: (key, on) => set((st) => ({ share: { ...st.share, [key]: on } })),
        setAccess: (connectionIds, allowed) =>
          set((st) => ({
            access: { ...st.access, ...Object.fromEntries(connectionIds.map((id) => [id, allowed])) },
          })),
        setModel: (agent, model) =>
          set((st) => {
            // An effort the new model doesn't take goes back to the default.
            const detected = st.agents?.find((a) => a.id === agent);
            const efforts = detected?.models.find((m) => m.id === model)?.efforts ?? [];
            const effort = st.modelChoice[agent].effort;
            return {
              modelChoice: {
                ...st.modelChoice,
                [agent]: { model, effort: effort && efforts.length && !efforts.includes(effort) ? null : effort },
              },
            };
          }),
        setEffort: (agent, effort) =>
          set((st) => ({ modelChoice: { ...st.modelChoice, [agent]: { ...st.modelChoice[agent], effort } } })),
        setPanelWidth: (width) => set({ panelWidth: width }),

        disable: () => {
          if (current()?.running) void get().stop();
          set({ enabled: false, panel: null });
        },

        enable: () => {
          set({ enabled: true, panel: "chat" });
          const s = current();
          const target = activeTarget();
          if (!s || (s.messages.length === 0 && target)) startSessionFor(target);
        },

        newSession: () => {
          const s = current();
          if (s?.running) void get().stop();
          const target = activeTarget();
          const allowed = target && isConnectionAllowed(target.connection.id);
          startSessionFor(
            allowed
              ? target
              : s
                ? {
                    connection: { id: s.connectionId, name: s.connectionName, summary: "" },
                    database: s.database,
                    table: s.table,
                  }
                : target,
          );
        },

        selectSession: (id) => set({ currentId: id, draft: "", context: [] }),

        clearSession: () => {
          const s = current();
          if (!s) return;
          closeBackend(s);
          const fresh = blankSession(get().agent, {
            connection: { id: s.connectionId, name: s.connectionName, summary: "" },
            database: s.database,
            table: s.table,
          });
          set((st) => ({
            sessions: st.sessions.map((x) => (x.id === s.id ? fresh : x)),
            currentId: fresh.id,
            draft: "",
            context: [],
          }));
        },

        setDraft: (text) => set({ draft: text }),
        addContext: (item) =>
          set((st) =>
            st.context.some((c) => c.label === item.label)
              ? st
              : { context: [...st.context, { ...item, id: uid() }] },
          ),
        removeContext: (id) => set((st) => ({ context: st.context.filter((c) => c.id !== id) })),

        send: async () => {
          const session = current();
          const text = get().draft.trim();
          if (!session || session.running || !text) return;
          const context = get().context;
          // A session that changed agents goes on with the new one, told
          // what was said so far.
          let prefix = "";
          let s = session;
          if (s.agent !== get().agent) {
            closeBackend(s);
            prefix = s.messages.length
              ? `Earlier in this conversation, with another assistant:\n${transcript(s.messages)}\n\n---\n`
              : "";
            patchSession(s.id, () => ({ agent: get().agent, agentSessionId: null, cliSessionId: null, runsWith: null }));
            s = current()!;
          }
          patchSession(s.id, (x) => ({
            title: x.title === "New session" ? (text.length > 44 ? `${text.slice(0, 44)}…` : text) : x.title,
            running: true,
            waiting: false,
            turnStartedAt: Date.now(),
            messages: [
              ...x.messages,
              { id: uid(), role: "user", text, context },
              {
                id: uid(),
                role: "agent",
                agent: x.agent,
                model: modelLabel(x.agent, get().agents, get().modelChoice[x.agent]),
                parts: [],
                error: null,
                stopped: false,
                done: false,
              },
            ],
          }));
          set({ draft: "", context: [] });
          try {
            const agentSessionId = await ensureBackend(current()!);
            await api.assistantSend(agentSessionId, prefix + withContext(text, context));
          } catch (e) {
            patchTurn(s.id, () => ({ error: String(e).replace(/^Error: /, ""), done: true }));
            patchSession(s.id, () => ({ running: false, waiting: false }));
          }
        },

        stop: async () => {
          const s = current();
          if (!s?.running) return;
          if (s.agentSessionId) {
            await api.assistantStop(s.agentSessionId).catch(() => {});
            // The backend answers a stop with turn-end; one with no turn
            // running (it had just ended) says nothing, so don't wait forever.
            window.setTimeout(() => {
              if (!get().sessions.find((x) => x.id === s.id)?.running) return;
              patchTurn(s.id, () => ({ stopped: true, done: true }));
              patchSession(s.id, () => ({ running: false, waiting: false }));
            }, 1500);
          } else {
            patchTurn(s.id, () => ({ stopped: true, done: true }));
            patchSession(s.id, () => ({ running: false, waiting: false }));
          }
        },

        answerApproval: async (requestId, choice) => {
          const inlineAsk = Object.values(get().inline).find((i) => i.approval?.requestId === requestId);
          const session = get().sessions.find((s) =>
            s.messages.some(
              (m) => m.role === "agent" && m.parts.some((p) => p.kind === "approval" && p.requestId === requestId),
            ),
          );
          const connectionId = session?.connectionId ?? (inlineAsk ? selectTab(inlineAsk.tabId)?.connection.id : undefined);
          if (choice === "always" && connectionId) {
            set((st) => ({
              valuesConnections: st.valuesConnections.includes(connectionId)
                ? st.valuesConnections
                : [...st.valuesConnections, connectionId],
            }));
          }
          removeApproval(requestId);
          await api.assistantAnswer(requestId, choice).catch(() => {});
        },

        markApplied: (cardId, applied) => {
          const s = current();
          if (s) patchSession(s.id, (x) => ({ applied: { ...x.applied, [cardId]: applied } }));
        },
        unmarkApplied: (cardId) => {
          const s = current();
          if (!s) return;
          patchSession(s.id, (x) => {
            const applied = { ...x.applied };
            delete applied[cardId];
            return { applied };
          });
        },

        askInline: () => {
          if (!get().enabled) {
            get().openPanel("setup");
            return;
          }
          const tab = selectActiveTab(useSessionsStore.getState());
          if (!tab) return;
          const consoleView =
            tab.kind === "console" || useUiStore.getState().mainTabs[tab.id] === "sql";
          if (!consoleView && tab.kind !== "table") return;
          if (get().inline[tab.id]) return;
          set((st) => ({
            inline: {
              ...st.inline,
              [tab.id]: {
                tabId: tab.id,
                kind: consoleView ? "script" : "filter",
                state: "ask",
                prompt: "",
                original: "",
                proposal: null,
                table: tab.kind === "table" ? `${tab.schema}.${tab.table}` : null,
                step: null,
                approval: null,
                error: null,
                agentSessionId: null,
                text: "",
              },
            },
          }));
        },

        setInlinePrompt: (tabId, prompt) => patchInline(tabId, { prompt }),

        generateInline: async (tabId) => {
          const ask = get().inline[tabId];
          const tab = selectTab(tabId);
          if (!ask || !tab || !ask.prompt.trim() || ask.state === "working") return;
          const live = useConnectionsStore.getState().sessions[tab.connection.id];
          if (!live) return;
          if (!isConnectionAllowed(tab.connection.id)) {
            patchInline(tabId, {
              state: "error",
              error: `${tab.connection.name} is not shared with the Assistant. Allow it in Assistant settings.`,
            });
            return;
          }
          const original =
            ask.kind === "filter"
              ? tab.kind === "table"
                ? tab.whereText
                : ""
              : (useConsoleStore.getState().consoles[tabId]?.script ?? defaultScript(tab));
          patchInline(tabId, { state: "working", original, step: null, error: null, text: "", proposal: null });
          const table = tab.kind === "table" ? `${tab.schema}.${tab.table}` : "";
          const prompt =
            ask.kind === "filter"
              ? `The WHERE field of the table ${table} holds:\n${original.trim() || "(empty: every row)"}\nWrite the complete new condition (no WHERE keyword) so that: ${ask.prompt.trim()}\nAnswer with one \`\`\`where ${table} block.`
              : `This SQL runs against the "${tab.database}" database:\n\`\`\`sql\n${original}\n\`\`\`\nChange it so that: ${ask.prompt.trim()}\nAnswer with one \`\`\`sql block holding the complete updated SQL.`;
          try {
            await listenToAgents();
            const { agentSessionId } = await api.assistantStart({
              agent: get().agent,
              purpose: "inline",
              connectionId: tab.connection.id,
              connectionName: tab.connection.name,
              sessionId: live.sessionId,
              database: tab.database,
              table: tab.kind === "table" ? `${tab.schema}.${tab.table}` : null,
              serverVersion: live.serverVersion,
              resumeId: null,
              model: get().modelChoice[get().agent].model,
              effort: get().modelChoice[get().agent].effort,
            });
            routes.set(agentSessionId, { type: "inline", tabId });
            patchInline(tabId, { agentSessionId });
            await api.assistantSend(agentSessionId, prompt);
          } catch (e) {
            patchInline(tabId, { state: "error", error: String(e).replace(/^Error: /, "") });
          }
        },

        acceptInline: (tabId) => {
          const ask = get().inline[tabId];
          const tab = selectTab(tabId);
          if (!ask?.proposal || !tab) return;
          get().closeInline(tabId);
          if (ask.kind === "script") {
            useConsoleStore.getState().setScript(tabId, ask.proposal);
            return;
          }
          if (tab.kind !== "table") return;
          const sessions = useSessionsStore.getState();
          sessions.applyWhere(tabId, ask.proposal);
          set({ flash: { tabId, field: "filter", at: Date.now() } });
          const live = useConnectionsStore.getState().sessions[tab.connection.id];
          if (live) void sessions.runQuery(live.sessionId, tabId);
        },

        closeInline: (tabId) => {
          const ask = get().inline[tabId];
          if (!ask) return;
          if (ask.agentSessionId) {
            routes.delete(ask.agentSessionId);
            void api.assistantClose(ask.agentSessionId).catch(() => {});
          }
          set((st) => {
            const inline = { ...st.inline };
            delete inline[tabId];
            return { inline };
          });
        },

        continueInline: (tabId) => {
          const ask = get().inline[tabId];
          const tab = selectTab(tabId);
          if (!ask || !tab) return;
          get().closeInline(tabId);
          const s = current();
          if (!s || s.connectionId !== tab.connection.id || s.database !== tab.database) {
            startSessionFor({
              connection: tab.connection,
              database: tab.database,
              table: tab.kind === "table" ? `${tab.schema}.${tab.table}` : null,
            });
          }
          set({
            panel: "chat",
            draft:
              ask.kind === "filter"
                ? `Refine the WHERE condition on ${tab.kind === "table" ? tab.table : tab.database}: ${ask.prompt.trim()}`
                : `Change the SQL: ${ask.prompt.trim()}`,
          });
        },
      };

      function removeApproval(requestId: string) {
        set((st) => ({
          sessions: st.sessions.map((s) => {
            const has = s.messages.some(
              (m) => m.role === "agent" && m.parts.some((p) => p.kind === "approval" && p.requestId === requestId),
            );
            if (!has) return s;
            return {
              ...s,
              waiting: false,
              messages: s.messages.map((m) =>
                m.role === "agent"
                  ? { ...m, parts: m.parts.filter((p) => !(p.kind === "approval" && p.requestId === requestId)) }
                  : m,
              ),
            };
          }),
          inline: Object.fromEntries(
            Object.entries(st.inline).map(([k, v]) => [
              k,
              v.approval?.requestId === requestId ? { ...v, approval: null } : v,
            ]),
          ),
        }));
      }
    },
    {
      name: "postgres-studio-assistant",
      version: 1,
      partialize: (s) => ({
        enabled: s.enabled,
        agent: s.agent,
        share: s.share,
        access: s.access,
        valuesConnections: s.valuesConnections,
        modelChoice: s.modelChoice,
        panelWidth: s.panelWidth,
      }),
    },
  ),
);

function selectTab(tabId: string) {
  return useSessionsStore.getState().tabs.find((t) => t.id === tabId) ?? null;
}

export function selectCurrentSession(s: AssistantState): AssistantSession | null {
  return s.sessions.find((x) => x.id === s.currentId) ?? null;
}

// ------------------------------------------------------------------ events

function onChat(sessionId: string, update: (s: AssistantSession) => Partial<AssistantSession>) {
  useAssistantStore.setState((st) => ({
    sessions: st.sessions.map((s) => (s.id === sessionId ? { ...s, ...update(s) } : s)),
  }));
}

/** The session's last message, the agent's turn, changed by `change`. */
function turn(
  s: AssistantSession,
  change: (m: Extract<AssistantMessage, { role: "agent" }>) => Partial<Extract<AssistantMessage, { role: "agent" }>>,
): Partial<AssistantSession> {
  const last = s.messages[s.messages.length - 1];
  if (!last || last.role !== "agent") return {};
  return { messages: [...s.messages.slice(0, -1), { ...last, ...change(last) }] };
}

function upsertText(parts: AgentPart[], blockId: string, text: string, done: boolean): AgentPart[] {
  const at = parts.findIndex((p) => p.kind === "text" && p.blockId === blockId);
  const part: AgentPart = { kind: "text", blockId, text, done };
  if (at === -1) return [...parts, part];
  return parts.map((p, i) => (i === at ? part : p));
}

function upsertStep(parts: AgentPart[], step: AssistantStep): AgentPart[] {
  const at = parts.findIndex((p) => p.kind === "steps" && p.steps.some((x) => x.stepId === step.stepId));
  if (at !== -1) {
    return parts.map((p, i) =>
      i === at && p.kind === "steps"
        ? { ...p, steps: p.steps.map((x) => (x.stepId === step.stepId ? step : x)) }
        : p,
    );
  }
  const last = parts[parts.length - 1];
  if (last?.kind === "steps") return [...parts.slice(0, -1), { ...last, steps: [...last.steps, step] }];
  return [...parts, { kind: "steps", steps: [step] }];
}

let listening: Promise<unknown> | null = null;

/**
 * Subscribes to the backend's Assistant events, once, the first time the
 * Assistant starts something - an app that never uses it never listens.
 */
function listenToAgents(): Promise<unknown> {
  listening ??= Promise.all([
    listen<AssistantEvent>("assistant-event", ({ payload }) => {
      const route = routes.get(payload.agentSessionId);
      if (!route) return;
      if (route.type === "inline") {
        const { inline } = useAssistantStore.getState();
        const ask = inline[route.tabId];
        if (!ask) return;
        const patch = (p: Partial<InlineAsk>) =>
          useAssistantStore.setState((st) => ({ inline: { ...st.inline, [route.tabId]: { ...st.inline[route.tabId], ...p } } }));
        if (payload.type === "text") patch({ text: payload.text });
        if (payload.type === "turn-end") {
          if (payload.stopped) return;
          const found = firstProposal(ask.text, ask.kind);
          if (payload.error || !found) {
            patch({
              state: "error",
              error: payload.error ?? `The answer had no ${ask.kind === "filter" ? "condition" : "SQL"} in it.`,
            });
          } else {
            patch({
              state: "review",
              proposal: ask.kind === "filter" ? found.code.trim().replace(/;$/, "") : found.code.replace(/\s+$/, "") + "\n",
              step: null,
            });
          }
          routes.delete(payload.agentSessionId);
          void api.assistantClose(payload.agentSessionId).catch(() => {});
        }
        return;
      }
      const { sessionId } = route;
      if (payload.type === "cli-session") onChat(sessionId, () => ({ cliSessionId: payload.cliSessionId }));
      else if (payload.type === "text") {
        onChat(sessionId, (s) => turn(s, (m) => ({ parts: upsertText(m.parts, payload.blockId, payload.text, payload.done) })));
      } else if (payload.type === "turn-end") {
        onChat(sessionId, (s) => ({
          ...turn(s, (m) => ({
            done: true,
            stopped: payload.stopped,
            error: payload.error,
            parts: m.parts
              .filter((p) => p.kind !== "approval")
              .map((p) => (p.kind === "steps" ? { ...p, steps: p.steps.filter((x) => x.state !== "run" || !payload.stopped) } : p)),
          })),
          running: false,
          waiting: false,
          turnStartedAt: null,
        }));
      }

    }),
    listen<AssistantStepEvent>("assistant-step", ({ payload }) => {
      const route = routes.get(payload.agentSessionId);
      if (!route) return;
      const { agentSessionId: _, ...step } = payload;
      if (route.type === "inline") {
        useAssistantStore.setState((st) =>
          st.inline[route.tabId]
            ? { inline: { ...st.inline, [route.tabId]: { ...st.inline[route.tabId], step: step.state === "run" ? step.label : null } } }
            : st,
        );
        return;
      }
      onChat(route.sessionId, (s) => turn(s, (m) => ({ parts: upsertStep(m.parts, step) })));

    }),
    listen<AssistantApprovalEvent>("assistant-approval", ({ payload }) => {
      const route = routes.get(payload.agentSessionId);
      if (!route) return;
      const { agentSessionId: _, ...approval } = payload;
      if (route.type === "inline") {
        useAssistantStore.setState((st) =>
          st.inline[route.tabId]
            ? { inline: { ...st.inline, [route.tabId]: { ...st.inline[route.tabId], approval } } }
            : st,
        );
        return;
      }
      onChat(route.sessionId, (s) => ({
        ...turn(s, (m) => ({ parts: [...m.parts, { kind: "approval", ...approval }] })),
        waiting: true,
      }));

    }),
    listen<{ requestId: string }>("assistant-approval-closed", ({ payload }) => {
      useAssistantStore.setState((st) => ({
        sessions: st.sessions.map((s) => ({
          ...s,
          messages: s.messages.map((m) =>
            m.role === "agent"
              ? { ...m, parts: m.parts.filter((p) => !(p.kind === "approval" && p.requestId === payload.requestId)) }
              : m,
          ),
        })),
        inline: Object.fromEntries(
          Object.entries(st.inline).map(([k, v]) => [k, v.approval?.requestId === payload.requestId ? { ...v, approval: null } : v]),
        ),
      }));
    }),
  ]);
  return listening;
}

// ------------------------------------------------------------------ policy

/** Keeps the backend's MCP server in step with the settings. */
function syncPolicy() {
  const st = useAssistantStore.getState();
  const profiles = useConnectionsStore.getState().profiles;
  void api
    .assistantSetPolicy({
      indexes: st.share.indexes,
      values: st.share.values,
      valuesConnections: st.valuesConnections,
      allowedConnections: profiles.filter((p) => isConnectionAllowed(p.id)).map((p) => p.id),
    })
    .catch(() => {});
}
useAssistantStore.subscribe((state, prev) => {
  if (
    state.share !== prev.share ||
    state.access !== prev.access ||
    state.valuesConnections !== prev.valuesConnections
  ) {
    syncPolicy();
  }
});
useConnectionsStore.subscribe((state, prev) => {
  if (state.profiles !== prev.profiles) syncPolicy();
});
syncPolicy();

// A tab's inline ask goes with the tab.
useSessionsStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return;
  const open = new Set(state.tabs.map((t) => t.id));
  for (const tabId of Object.keys(useAssistantStore.getState().inline)) {
    if (!open.has(tabId)) useAssistantStore.getState().closeInline(tabId);
  }
});
