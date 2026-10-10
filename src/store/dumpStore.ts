import { create } from "zustand";
import type { TabConnection } from "./sessionsStore";

/** The database a backup or a restore is about. */
export interface DumpDialog {
  kind: "backup" | "restore";
  connection: TabConnection;
  database: string;
}

interface DumpState {
  dialog: DumpDialog | null;
  open: (kind: DumpDialog["kind"], connection: TabConnection, database: string) => void;
  close: () => void;
}

/** Which backup or restore dialog is open; DialogHost shows it. */
export const useDumpStore = create<DumpState>((set) => ({
  dialog: null,
  open: (kind, connection, database) => set({ dialog: { kind, connection, database } }),
  close: () => set({ dialog: null }),
}));
