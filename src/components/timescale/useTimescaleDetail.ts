import { useCallback, useEffect, useRef, useState } from "react";
import { timescaleApi } from "@/lib/timescaleApi";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { TableTab } from "../../store/sessionsStore";
import { timescaleActionBlock, useTimescaleInfo } from "../../store/timescaleInfo";
import type { CaggDetail, HypertableDetail, TimescaleInfo } from "../../types/timescale";
import type { TimescaleTarget } from "./RefreshCaggDialog";

export interface TimescaleDetail {
  detail: HypertableDetail | CaggDetail | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** After an action: the detail again and the header numbers. */
  done: () => void;
  /** The extension's version and edition; null until the catalog is known. */
  info: TimescaleInfo | null;
  /** Null while the connection has no session. */
  target: TimescaleTarget | null;
  /** Why a write action is off, or null. */
  block: (needsCommunity: boolean) => string | null;
  open: (schema: string, name: string, relkind: "r" | "v") => void;
}

/**
 * A hypertable's or continuous aggregate's chunks, policies and relatives.
 * Reads nothing for other relations.
 */
export function useTimescaleDetail(tab: TableTab): TimescaleDetail {
  const sessionId = useConnectionsStore((s) => s.sessions[tab.connection.id]?.sessionId);
  const readOnly = useConnectionsStore((s) => s.sessions[tab.connection.id]?.readOnly ?? false);
  const kind = tab.info?.hypertable ? "hypertable" : tab.info?.cagg ? "cagg" : null;
  const info = useTimescaleInfo(tab.connection.id, kind ? sessionId : undefined, tab.database);
  const [detail, setDetail] = useState<HypertableDetail | CaggDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (!kind || !sessionId) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const next =
        kind === "hypertable"
          ? await timescaleApi.hypertable(sessionId, tab.database, tab.schema, tab.table)
          : await timescaleApi.cagg(sessionId, tab.database, tab.schema, tab.table);
      if (mine !== latest.current) return;
      setDetail(next);
      setError(null);
    } catch (e) {
      if (mine === latest.current) setError(String(e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [kind, sessionId, tab.database, tab.schema, tab.table]);

  useEffect(() => {
    setDetail(null);
    void reload();
  }, [reload]);

  const done = useCallback(() => {
    void reload();
    if (sessionId) void useSessionsStore.getState().loadInfo(sessionId, tab.id);
  }, [reload, sessionId, tab.id]);

  const target: TimescaleTarget | null = sessionId ? { connection: tab.connection, sessionId, database: tab.database } : null;
  const open = (schema: string, name: string, relkind: "r" | "v") => {
    if (sessionId) void useSessionsStore.getState().openTable(sessionId, tab.connection, tab.database, schema, name, relkind);
  };

  return {
    detail,
    loading,
    error,
    reload,
    done,
    info,
    target,
    block: (needsCommunity) => (target ? timescaleActionBlock(info, readOnly, needsCommunity) : "The connection isn't open"),
    open,
  };
}
