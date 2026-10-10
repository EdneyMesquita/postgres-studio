import { invoke } from "@tauri-apps/api/core";
import type { ActivityRow, AvailableExtension, ExtensionAction, ExtensionInfo, LockRow, RoleInfo } from "../types/objects";

/** The commands for extensions, activity, roles and maintenance. */
export const objectsApi = {
  listExtensions: (sessionId: string, database: string) =>
    invoke<ExtensionInfo[]>("list_extensions", { sessionId, database }),

  listAvailableExtensions: (sessionId: string, database: string) =>
    invoke<AvailableExtension[]>("list_available_extensions", { sessionId, database }),

  /** Installs, updates or drops one extension; the caller has asked the user. */
  extensionAction: (sessionId: string, database: string, name: string, action: ExtensionAction) =>
    invoke<void>("extension_action", { sessionId, database, name, action }),

  /** Every backend of the server, but the one that asks. */
  serverActivity: (sessionId: string, database: string) =>
    invoke<ActivityRow[]>("server_activity", { sessionId, database }),

  /** The locks waiting or blocking; with `all`, every lock. */
  serverLocks: (sessionId: string, database: string, all: boolean) =>
    invoke<LockRow[]>("server_locks", { sessionId, database, all }),

  /**
   * Cancels the backend's query, or with `terminate` ends its session.
   * Resolves to whether the server signalled it.
   */
  signalBackend: (sessionId: string, database: string, pid: number, terminate: boolean) =>
    invoke<boolean>("signal_backend", { sessionId, database, pid, terminate }),

  /** The server's roles; they are shared by every database. */
  listRoles: (sessionId: string, database: string) => invoke<RoleInfo[]>("list_roles", { sessionId, database }),
};
