import { invoke } from "@tauri-apps/api/core";
import type {
  CaggDetail,
  DropChunksPreview,
  HypertableDetail,
  JobInfo,
  TimescaleAction,
  TimescaleInfo,
} from "../types/timescale";

/** The TimescaleDB commands. Reads work on any version; actions need 2.18+ and a writable connection. */
export const timescaleApi = {
  /** The extension's version and edition, or null when it isn't installed. */
  info: (sessionId: string, database: string) => invoke<TimescaleInfo | null>("timescale_info", { sessionId, database }),

  hypertable: (sessionId: string, database: string, schema: string, name: string) =>
    invoke<HypertableDetail>("timescale_hypertable", { sessionId, database, schema, name }),

  cagg: (sessionId: string, database: string, schema: string, name: string) =>
    invoke<CaggDetail>("timescale_cagg", { sessionId, database, schema, name }),

  /** Every job the role can see, with its last run and last error. */
  jobs: (sessionId: string, database: string) => invoke<JobInfo[]>("timescale_jobs", { sessionId, database }),

  /** What drop_chunks would remove, shown before asking. */
  dropChunksPreview: (sessionId: string, database: string, schema: string, name: string, olderThan: string) =>
    invoke<DropChunksPreview>("timescale_drop_chunks_preview", { sessionId, database, schema, name, olderThan }),

  /** The one statement an action runs, for the confirmation. */
  actionSql: (sessionId: string, database: string, action: TimescaleAction) =>
    invoke<string>("timescale_action_sql", { sessionId, database, action }),

  /** Runs an action the user confirmed; resolves to the time it took, in ms. */
  action: (sessionId: string, database: string, action: TimescaleAction) =>
    invoke<number>("timescale_action", { sessionId, database, action }),
};
