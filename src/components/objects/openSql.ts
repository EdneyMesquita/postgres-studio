import { useConsoleStore } from "../../store/consoleStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { TabConnection } from "../../store/sessionsStore";

/** Puts generated SQL in a new console on the database, for reading and running by hand. */
export function openSql(connection: TabConnection, database: string, sql: string): string {
  const id = useSessionsStore.getState().openConsole(connection, database);
  useConsoleStore.getState().setScript(id, sql.endsWith("\n") ? sql : `${sql}\n`);
  return id;
}
