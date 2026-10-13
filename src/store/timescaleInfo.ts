import { useEffect } from "react";
import type { TimescaleInfo } from "../types/timescale";
import { databaseKey } from "./explorerStore";
import { useGraphStore } from "./graphStore";

/**
 * TimescaleDB in a database, read with the graph catalog the explorer
 * loads anyway: null while unknown or without the extension. Asks for the
 * catalog when a page needs it before the explorer opened the database.
 */
export function useTimescaleInfo(connectionId: string, sessionId: string | undefined, database: string): TimescaleInfo | null {
  const info = useGraphStore((s) => s.nodes[databaseKey(connectionId, database)]?.catalog?.timescale ?? null);
  useEffect(() => {
    if (sessionId) void useGraphStore.getState().ensure(connectionId, sessionId, database);
  }, [connectionId, sessionId, database]);
  return info;
}

/** Why a TimescaleDB action can't run here, or null when it can; buttons show it as their title. */
export function timescaleActionBlock(
  info: TimescaleInfo | null,
  readOnly: boolean,
  needsCommunity: boolean,
): string | null {
  if (!info) return "TimescaleDB isn't installed in this database";
  if (readOnly) return "This connection is read-only";
  if (!info.columnstoreApi) return `TimescaleDB ${info.version} is older than 2.18; the app only reads it`;
  if (needsCommunity && !info.community) return "Not in the Apache edition of TimescaleDB this server runs";
  return null;
}
