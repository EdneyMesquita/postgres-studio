import { invoke } from "@tauri-apps/api/core";
import type { AvailableExtension, ExtensionAction, ExtensionInfo } from "../types/objects";

/** The commands for extensions, activity, roles and maintenance. */
export const objectsApi = {
  listExtensions: (sessionId: string, database: string) =>
    invoke<ExtensionInfo[]>("list_extensions", { sessionId, database }),

  listAvailableExtensions: (sessionId: string, database: string) =>
    invoke<AvailableExtension[]>("list_available_extensions", { sessionId, database }),

  /** Installs, updates or drops one extension; the caller has asked the user. */
  extensionAction: (sessionId: string, database: string, name: string, action: ExtensionAction) =>
    invoke<void>("extension_action", { sessionId, database, name, action }),
};
