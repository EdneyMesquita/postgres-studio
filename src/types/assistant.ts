/** The AI coding agents the Assistant can drive: CLIs already on the machine. */
export type AgentKind = "claude" | "codex";

/** A model an agent can run. */
export interface AgentModel {
  /** What the CLI takes: an alias ("sonnet") or a model name. */
  id: string;
  name: string;
  description: string | null;
  /** Effort levels it takes; empty means the agent's own list. */
  efforts: string[];
  defaultEffort: string | null;
}

/** A CLI found (or not) on this machine. */
export interface DetectedAgent {
  id: AgentKind;
  /** "Claude Code" or "Codex". */
  name: string;
  /** Where it was found, with the home directory as "~". Null when missing. */
  path: string | null;
  version: string | null;
  error: string | null;
  /** Codex: the models the account can use; Claude Code: its aliases. */
  models: AgentModel[];
  /** Effort levels the CLI accepts. */
  efforts: string[];
  /** The model set up in the CLI itself, used for "Default". */
  defaultModel: string | null;
  defaultEffort: string | null;
}

/** The model and effort the user picked for an agent; null means the CLI's own. */
export interface ModelChoice {
  model: string | null;
  effort: string | null;
}

/** What the agent may read, sent to the backend's MCP server. */
export interface AssistantPolicy {
  indexes: boolean;
  /** Document values without asking, everywhere. */
  values: boolean;
  /** Connections where the user chose "Always allow" for row values. */
  valuesConnections: string[];
  /** Connections the Assistant may read at all. */
  allowedConnections: string[];
}

export type AssistantPurpose = "chat" | "inline";

export interface AssistantStartInput {
  agent: AgentKind;
  purpose: AssistantPurpose;
  connectionId: string;
  connectionName: string;
  /** The app's session for the connection. */
  sessionId: string;
  database: string;
  /** The table in view, as schema.table. */
  table: string | null;
  serverVersion: string | null;
  /** The CLI's own session to continue, after a restart or a reconnect. */
  resumeId: string | null;
  /** Null runs the model set up in the CLI itself. */
  model: string | null;
  effort: string | null;
}

export type ApprovalChoice = "once" | "always" | "deny";

/** Streamed from the agent's CLI. */
export type AssistantEvent =
  | { type: "cli-session"; agentSessionId: string; cliSessionId: string }
  | { type: "text"; agentSessionId: string; blockId: string; text: string; done: boolean }
  | { type: "turn-end"; agentSessionId: string; error: string | null; stopped: boolean };

export type StepState = "run" | "ok" | "error" | "denied";

/** One read-only tool call, reported by the app's own MCP server. */
export interface AssistantStepEvent {
  agentSessionId: string;
  stepId: string;
  tool: string;
  state: StepState;
  label: string;
  meta: string;
  /** The call as made, e.g. describe_table({"table":"public.orders"}). */
  call: string;
  /** One-line summary of what came back. */
  out: string;
}

/** A tool needs row values and the user hasn't allowed them. */
export interface AssistantApprovalEvent {
  agentSessionId: string;
  requestId: string;
  tool: string;
  database: string;
  table: string | null;
  limit: number;
  /** Where the values would go: "Anthropic" or "OpenAI". */
  provider: string;
}
