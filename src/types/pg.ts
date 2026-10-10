/** What the backend reads from PostgreSQL. Values are always text, as psql shows them. */

export interface DatabaseInfo {
  name: string;
  sizeBytes: number | null;
  owner: string | null;
  encoding: string | null;
  comment: string | null;
}

export interface SchemaInfo {
  name: string;
  owner: string | null;
  /** pg_catalog, information_schema and the like. */
  system: boolean;
  comment: string | null;
}

/** r table, p partitioned, f foreign, v view, m materialized view, S sequence. */
export type RelKind = "r" | "p" | "f" | "v" | "m" | "S";

export interface RelationEntry {
  name: string;
  kind: RelKind;
  rowEstimate: number | null;
  comment: string | null;
}

export interface FunctionEntry {
  name: string;
  args: string;
  /** f function, p procedure, a aggregate, w window. */
  kind: "f" | "p" | "a" | "w";
  returns: string | null;
  oid: number;
}

export interface TypeEntry {
  name: string;
  /** e enum, c composite, d domain, r range. */
  kind: "e" | "c" | "d" | "r";
}

export interface SchemaObjects {
  tables: RelationEntry[];
  views: RelationEntry[];
  materializedViews: RelationEntry[];
  sequences: RelationEntry[];
  functions: FunctionEntry[];
  types: TypeEntry[];
}

export interface ColumnInfo {
  name: string;
  position: number;
  typeName: string;
  typeOid: number;
  /** pg_type.typcategory: N numeric, S string, B boolean, D date/time, U user/json, A array, E enum... */
  category: string;
  nullable: boolean;
  default: string | null;
  identity: "a" | "d" | null;
  generated: string | null;
  comment: string | null;
  enumValues: string[] | null;
}

export interface ConstraintInfo {
  name: string;
  /** p primary, u unique, f foreign, c check, x exclusion. */
  kind: string;
  definition: string;
  columns: string[] | null;
  refSchema: string | null;
  refTable: string | null;
  refColumns: string[] | null;
}

export interface IncomingKey {
  name: string;
  schema: string;
  table: string;
  columns: string[];
  refColumns: string[];
}

export interface IndexInfo {
  name: string;
  method: string;
  definition: string;
  unique: boolean;
  primary: boolean;
  sizeBytes: number | null;
  scans: number | null;
  columns: string[];
  constraint: string | null;
  /** False after a failed CREATE INDEX CONCURRENTLY. */
  valid: boolean;
  partial: boolean;
  /** The WHERE clause of a partial index. */
  predicate: string | null;
  /** A key is an expression, not a column. */
  expression: boolean;
  /** Columns carried by INCLUDE. */
  include: string[];
}

export interface TriggerInfo {
  name: string;
  definition: string;
  enabled: boolean;
  /** pg_trigger.tgenabled: O on, D off, R replica only, A always. */
  enabledState: string;
  timing: "BEFORE" | "AFTER" | "INSTEAD OF";
  events: string[];
  level: "row" | "statement";
  /** The function it runs, e.g. audit.log_change(). */
  function: string;
}

export interface TableStats {
  seqScans: number | null;
  idxScans: number | null;
  liveRows: number | null;
  deadRows: number | null;
  lastVacuum: string | null;
  lastAnalyze: string | null;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: RelKind;
  rowEstimate: number | null;
  sizeBytes: number | null;
  comment: string | null;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  referencedBy: IncomingKey[];
  indexes: IndexInfo[];
  triggers: TriggerInfo[];
  viewDefinition: string | null;
  stats: TableStats | null;
  /** The columns that identify a row; empty means read-only. */
  rowKey: string[];
  ddl: string;
}

export interface ResultColumn {
  name: string;
  typeName: string;
  typeOid: number;
}

export type Row = (string | null)[];

export interface DbError {
  message: string;
  code: string | null;
  detail: string | null;
  hint: string | null;
  /** 1-based character position in the statement. */
  position: number | null;
  severity: string | null;
}

export interface Notice {
  severity: string;
  message: string;
  detail: string | null;
  hint: string | null;
}

export interface StatementResult {
  index: number;
  /** Character offsets in the text that was run. */
  start: number;
  end: number;
  command: string;
  returnsRows: boolean;
  columns: ResultColumn[];
  rows: Row[];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  error: DbError | null;
}

export type TxState = "idle" | "active" | "failed" | "unknown";

export interface SqlRun {
  results: StatementResult[];
  notices: Notice[];
  transaction: TxState;
  elapsedMs: number;
}

export interface BrowseInput {
  whereClause: string | null;
  orderBy: string | null;
  limit: number;
  offset: number;
}

export interface BrowseResult {
  columns: ResultColumn[];
  rows: Row[];
  hasMore: boolean;
  elapsedMs: number;
  notices: Notice[];
}

export interface CellValue {
  column: string;
  value: string | null;
  useDefault?: boolean;
}

export type RowEdit =
  | { kind: "update"; key: CellValue[]; values: CellValue[] }
  | { kind: "insert"; values: CellValue[] }
  | { kind: "delete"; key: CellValue[] };

export interface ApplyResult {
  /** Per edit, the row as stored afterwards (null for deletes). */
  rows: (Row | null)[];
}

export interface ExplainResult {
  plan: unknown;
  analyzed: boolean;
  elapsedMs: number;
}

export type ExportFormat = "csv" | "json";

export interface ExportSummary {
  rowsWritten: number;
  columns: string[];
}

export interface ExportProgressEvent {
  executionId: string;
  rowsWritten: number;
}

export interface DiagramColumn {
  name: string;
  /** As format_type writes it, e.g. "timestamp with time zone". */
  type: string;
  notNull: boolean;
  pk: boolean;
  fk: boolean;
}

export interface DiagramTable {
  name: string;
  kind: RelKind;
  rowEstimate: number | null;
  columns: DiagramColumn[];
}

export interface DiagramForeignKey {
  name: string;
  table: string;
  columns: string[];
  /** May be another schema. */
  refSchema: string;
  refTable: string;
  refColumns: string[];
}

export interface SchemaDiagram {
  tables: DiagramTable[];
  foreignKeys: DiagramForeignKey[];
}

export type BackupFormat = "custom" | "plain" | "directory" | "tar";

/** Everything, only the schema, or only the rows. */
export type BackupContent = "all" | "schema_only" | "data_only";

export interface PgTool {
  path: string;
  /** As --version prints it, e.g. "17.6". */
  version: string;
  major: number;
}

/** Every copy of the client tools found, newest first, and where it looked. */
export interface PgToolsInfo {
  pgDump: PgTool[];
  pgRestore: PgTool[];
  psql: PgTool[];
  searched: string[];
}

export interface TableRef {
  schema: string;
  name: string;
}

export interface DumpOptions {
  format: BackupFormat;
  content: BackupContent;
  /** Only these, when not empty. */
  schemas: string[];
  tables: TableRef[];
  /** Kept in the backup without their rows. */
  excludeData: TableRef[];
  noOwner: boolean;
  noPrivileges: boolean;
  /** Plain format: drop each object before creating it. */
  clean: boolean;
  /** 0-9, for the custom and directory formats. */
  compression: number | null;
  /** Directory format only. */
  jobs: number | null;
}

export interface RestoreOptions {
  content: BackupContent;
  clean: boolean;
  create: boolean;
  noOwner: boolean;
  noPrivileges: boolean;
  singleTransaction: boolean;
  exitOnError: boolean;
  jobs: number | null;
}

export interface DumpSummary {
  path: string;
  bytes: number;
  elapsedMs: number;
  warnings: string[];
}

export interface RestoreSummary {
  format: BackupFormat;
  elapsedMs: number;
  warnings: string[];
  /** Statements that failed, when the restore went on past them. */
  errors: string[];
}

export interface ToolProgressEvent {
  executionId: string;
  line: string;
  /** Objects handled so far. */
  objects: number;
}

export interface GraphLabel {
  name: string;
  /** `v` vertex label, `e` edge label. */
  kind: "v" | "e";
  /** From the label table's reltuples: null until it was analyzed. */
  rowEstimate: number | null;
}

/** An Apache AGE graph and the labels it holds. */
export interface GraphInfo {
  name: string;
  /** The schema holding the graph's label tables. */
  namespace: string;
  labels: GraphLabel[];
}

/** A SQL/PGQ property graph: only listed by servers that have them. */
export interface PropertyGraphInfo {
  name: string;
  schema: string;
  elements: string[];
}

/** The graph and vector features of one database. */
export interface GraphCatalog {
  age: boolean;
  vector: boolean;
  graphs: GraphInfo[];
  propertyGraphs: PropertyGraphInfo[];
}

export interface ScriptOptions {
  /** Stop at the first failing statement; otherwise go on and list them. */
  stopOnError: boolean;
  /** Run it all in one transaction, rolled back on an error. */
  singleTransaction: boolean;
}

export interface SqlFileInfo {
  name: string;
  sizeBytes: number;
}

export interface ScriptProgress {
  executionId: string;
  statementsDone: number;
  bytesRead: number;
  totalBytes: number;
  errors: number;
  /** The start of the statement running now. */
  currentPreview: string;
}

export interface ScriptError {
  /** 1-based position among the statements. */
  index: number;
  /** Line the statement starts on. */
  line: number;
  message: string;
  code: string | null;
}

export interface ScriptWarning {
  line: number;
  message: string;
}

export interface ScriptSummary {
  statements: number;
  /** The first errors; `errorCount` is how many there were. */
  errors: ScriptError[];
  errorCount: number;
  warnings: ScriptWarning[];
  warningCount: number;
  copiedRows: number;
  bytesRead: number;
  totalBytes: number;
  elapsedMs: number;
  cancelled: boolean;
  /** Ended at an error, before the end of the file. */
  stopped: boolean;
  rolledBack: boolean;
}

export interface CsvOptions {
  /** One character; "\t" is a tab. */
  delimiter: string;
  quote: string;
  /** The first row names the columns and is not loaded. */
  header: boolean;
  /** The text that means NULL; empty: an empty field is NULL. */
  nullString: string;
}

export interface CsvPreview {
  headers: string[] | null;
  rows: (string | null)[][];
  /** The widest row seen. */
  columns: number;
  totalBytes: number;
  /** The file goes on past the rows shown. */
  more: boolean;
}

export interface CsvProgress {
  executionId: string;
  bytesRead: number;
  totalBytes: number;
  rows: number;
}

export interface CsvImportSummary {
  rows: number;
  bytes: number;
  elapsedMs: number;
}
