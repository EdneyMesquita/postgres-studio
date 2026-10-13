/** TimescaleDB, as `src-tauri/src/pg/timescale.rs` reads it. */

export interface TimescaleInfo {
  /** e.g. `2.30.2`. */
  version: string;
  major: number;
  minor: number;
  /** `timescale` (Community) or `apache`. */
  license: string;
  schema: string;
  /** 2.18 or later: the app's actions need it; older servers are read only. */
  columnstoreApi: boolean;
  /** Community edition: continuous aggregates, columnstore, policies, jobs. */
  community: boolean;
}

export interface Dimension {
  number: number;
  column: string;
  columnType: string;
  /** `Time` or `Space`. */
  kind: string;
  timeInterval: string | null;
  integerInterval: number | null;
  numPartitions: number | null;
}

export interface HypertableSummary {
  dimensions: Dimension[];
  numChunks: number;
  compressedChunks: number;
  columnstore: boolean;
  totalBytes: number | null;
  approxRows: number | null;
}

export interface CaggSummary {
  sourceSchema: string;
  sourceName: string;
  /** `hypertable` or `cagg` (hierarchical). */
  sourceKind: string;
  materializationSchema: string;
  materializationName: string;
  /** The user's query. */
  viewDefinition: string;
  materializedOnly: boolean;
  columnstore: boolean;
  /** The time_bucket width in the definition, e.g. `1 hour`. */
  bucketWidth: string | null;
  totalBytes: number | null;
  approxRows: number | null;
}

export interface ChunkParent {
  hypertableSchema: string;
  hypertableName: string;
  isCompressed: boolean;
}

export interface ChunkInfo {
  schema: string;
  name: string;
  rangeStart: string | null;
  rangeEnd: string | null;
  isCompressed: boolean;
  totalBytes: number | null;
  /** Columnstore stats; null for a rowstore chunk. */
  beforeBytes: number | null;
  afterBytes: number | null;
}

export type JobKind = "refresh" | "columnstore" | "retention" | "reorder" | "custom" | "internal";

export interface JobInfo {
  jobId: number;
  applicationName: string;
  procSchema: string;
  procName: string;
  kind: JobKind;
  targetSchema: string | null;
  targetName: string | null;
  scheduleInterval: string | null;
  scheduled: boolean;
  config: Record<string, unknown> | null;
  owner: string | null;
  /** `Success` or `Failed`; null before the first run. */
  lastRunStatus: string | null;
  /** `Scheduled`, `Running` or `Paused`. */
  jobStatus: string | null;
  lastRunStartedAt: string | null;
  lastSuccessfulFinish: string | null;
  lastRunDuration: string | null;
  nextStart: string | null;
  totalRuns: number | null;
  totalFailures: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface ColumnstoreSettings {
  segmentby: string[];
  orderby: string[];
}

export interface CompressionTotals {
  totalChunks: number;
  compressedChunks: number;
  beforeBytes: number | null;
  afterBytes: number | null;
}

export interface RelationRef {
  schema: string;
  name: string;
}

export interface HypertableDetail {
  /** Newest first. */
  chunks: ChunkInfo[];
  settings: ColumnstoreSettings | null;
  totals: CompressionTotals | null;
  policies: JobInfo[];
  caggs: RelationRef[];
}

export interface CaggDetail {
  /** `ok`, `never` (nothing materialized) or `unavailable`. */
  watermarkState: "ok" | "never" | "unavailable";
  /** The newest materialized bucket. */
  watermark: string | null;
  lag: string | null;
  policy: JobInfo | null;
  children: RelationRef[];
  chunks: ChunkInfo[];
}

export interface DropChunksPreview {
  chunks: ChunkInfo[];
  totalBytes: number;
  dependentCaggs: RelationRef[];
}

export type TimescaleAction =
  | { kind: "refreshCagg"; schema: string; name: string; start: string | null; end: string | null }
  | { kind: "runJob"; jobId: number }
  | { kind: "pauseJob"; jobId: number }
  | { kind: "resumeJob"; jobId: number }
  | { kind: "toColumnstore"; schema: string; name: string }
  | { kind: "toRowstore"; schema: string; name: string }
  | { kind: "dropChunks"; schema: string; name: string; olderThan: string }
  | { kind: "setRealtime"; schema: string; name: string; enabled: boolean };
