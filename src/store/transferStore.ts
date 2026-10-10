import { create } from "zustand";
import { toast } from "sonner";
import { sessionIdFor } from "./connectionsStore";
import type { TabConnection } from "./sessionsStore";

/** A database a SQL file will run on. */
export interface ScriptTarget {
  connection: TabConnection;
  sessionId: string;
  database: string;
}

/** A table a CSV file will be loaded into. */
export interface CsvTarget extends ScriptTarget {
  schema: string;
  table: string;
}

interface TransferState {
  scriptTarget: ScriptTarget | null;
  csvTarget: CsvTarget | null;
  setScriptTarget: (target: ScriptTarget | null) => void;
  setCsvTarget: (target: CsvTarget | null) => void;
}

/** Which "Run SQL file" and "Import CSV" dialogs are open, and for what. */
export const useTransferStore = create<TransferState>((set) => ({
  scriptTarget: null,
  csvTarget: null,
  setScriptTarget: (scriptTarget) => set({ scriptTarget }),
  setCsvTarget: (csvTarget) => set({ csvTarget }),
}));

/** Opens the Run SQL file dialog for a database of a connected connection. */
export function openRunSqlFile(connection: TabConnection, database: string) {
  const sessionId = sessionIdFor(connection.id);
  if (!sessionId) {
    toast.error("Connect first", { description: `${connection.name} isn't connected.` });
    return;
  }
  useTransferStore.getState().setScriptTarget({ connection, sessionId, database });
}

/** Opens the Import CSV dialog for a table of a connected connection. */
export function openImportCsv(connection: TabConnection, database: string, schema: string, table: string) {
  const sessionId = sessionIdFor(connection.id);
  if (!sessionId) {
    toast.error("Connect first", { description: `${connection.name} isn't connected.` });
    return;
  }
  useTransferStore.getState().setCsvTarget({ connection, sessionId, database, schema, table });
}
