/** An extension installed in a database. */
export interface ExtensionInfo {
  name: string;
  version: string;
  schema: string;
  comment: string | null;
}

/** An extension the server has files for, installed here or not. */
export interface AvailableExtension {
  name: string;
  defaultVersion: string | null;
  /** Null when it is not installed in this database. */
  installedVersion: string | null;
  schema: string | null;
  comment: string | null;
}

export type ExtensionAction =
  | { kind: "install"; schema: string | null }
  | { kind: "update" }
  | { kind: "drop"; cascade: boolean };

/** One backend, as pg_stat_activity shows it. */
export interface ActivityRow {
  pid: number;
  user: string | null;
  database: string | null;
  application: string | null;
  clientAddr: string | null;
  /** active, idle, idle in transaction...; null for background processes. */
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  backendType: string | null;
  xactStart: string | null;
  /** How long its transaction has been open, in ms. */
  xactAgeMs: number | null;
  queryStart: string | null;
  /** How long ago the query began, in ms: its duration while active. */
  queryAgeMs: number | null;
  /** The backends this one waits on. */
  blockedBy: number[];
  query: string | null;
  /** One of this app's own sessions. */
  own: boolean;
}

/** One lock held or awaited. */
export interface LockRow {
  pid: number;
  user: string | null;
  database: string | null;
  application: string | null;
  locktype: string;
  mode: string;
  granted: boolean;
  relation: string | null;
  /** Who holds what this lock waits for; empty when granted. */
  blockedBy: number[];
  /** Another backend waits on this one. */
  blocking: boolean;
  state: string | null;
  query: string | null;
  queryAgeMs: number | null;
  own: boolean;
}

/** A role of the server. */
export interface RoleInfo {
  name: string;
  canLogin: boolean;
  superuser: boolean;
  createDb: boolean;
  createRole: boolean;
  replication: boolean;
  bypassRls: boolean;
  inherit: boolean;
  /** -1 for no limit. */
  connectionLimit: number;
  /** As the server writes it; null when it never expires. */
  validUntil: string | null;
  memberOf: string[];
  comment: string | null;
  /** A predefined pg_* role. */
  system: boolean;
}
