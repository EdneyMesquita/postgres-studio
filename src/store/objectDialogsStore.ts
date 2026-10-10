import { create } from "zustand";
import type { TabConnection } from "./sessionsStore";

/** What a database-level dialog is about: a database of a connected connection. */
export interface DatabaseTarget {
  connection: TabConnection;
  sessionId: string;
  database: string;
}

/** The roles dialog is about the server, not one database; the database is where it reads. */
export type RolesTarget = DatabaseTarget;

interface ObjectDialogsState {
  extensions: DatabaseTarget | null;
  roles: RolesTarget | null;
  openExtensions: (target: DatabaseTarget) => void;
  closeExtensions: () => void;
  openRoles: (target: RolesTarget) => void;
  closeRoles: () => void;
}

/** The dialogs of the object tools, opened from anywhere and hosted by `DialogHost`. */
export const useObjectDialogsStore = create<ObjectDialogsState>((set) => ({
  extensions: null,
  roles: null,
  openExtensions: (extensions) => set({ extensions }),
  closeExtensions: () => set({ extensions: null }),
  openRoles: (roles) => set({ roles }),
  closeRoles: () => set({ roles: null }),
}));
