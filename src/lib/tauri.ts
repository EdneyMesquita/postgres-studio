import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionHandle,
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionProfileMeta,
  ConnectionImportPreview,
  ConnectionTestResult,
  ConnectionsExportSummary,
  ConnectionsImportSummary,
  SecretBackendInfo,
} from "../types/connection";
import type {
  ApplyResult,
  BrowseInput,
  BrowseResult,
  DatabaseInfo,
  ExplainResult,
  ExportFormat,
  ExportSummary,
  ResultColumn,
  Row,
  RowEdit,
  SchemaDiagram,
  SchemaInfo,
  SchemaObjects,
  SqlRun,
  TableInfo,
  TxState,
} from "../types/pg";
import type { SavedScript } from "../types/script";
import type {
  ApprovalChoice,
  AssistantPolicy,
  AssistantStartInput,
  DetectedAgent,
} from "../types/assistant";

export const api = {
  listConnectionProfiles: () => invoke<ConnectionProfileMeta[]>("list_connection_profiles"),

  getConnectionProfile: (id: string) => invoke<ConnectionProfile>("get_connection_profile", { id }),

  saveConnectionProfile: (input: ConnectionProfileInput) =>
    invoke<ConnectionProfileMeta>("save_connection_profile", { input }),

  deleteConnectionProfile: (id: string) => invoke<void>("delete_connection_profile", { id }),

  testConnection: (input: ConnectionProfileInput) =>
    invoke<ConnectionTestResult>("test_connection", { input }),

  connect: (id: string) => invoke<ConnectionHandle>("connect", { id }),

  disconnect: (sessionId: string) => invoke<void>("disconnect", { sessionId }),

  secretBackendInfo: () => invoke<SecretBackendInfo>("secret_backend_info"),

  /** Opens the app's log folder in the file manager; resolves to its path. */
  openLogDir: () => invoke<string>("open_log_dir"),

  exportConnections: (destPath: string, includeSecrets: boolean) =>
    invoke<ConnectionsExportSummary>("export_connections", { destPath, includeSecrets }),

  previewConnectionsImport: (srcPath: string) =>
    invoke<ConnectionImportPreview[]>("preview_connections_import", { srcPath }),

  /** Imports the connections at `selected` positions of the file. */
  importConnections: (srcPath: string, selected: number[]) =>
    invoke<ConnectionsImportSummary>("import_connections", { srcPath, selected }),

  listDatabases: (sessionId: string) => invoke<DatabaseInfo[]>("list_databases", { sessionId }),

  listSchemas: (sessionId: string, database: string) =>
    invoke<SchemaInfo[]>("list_schemas", { sessionId, database }),

  listSchemaObjects: (sessionId: string, database: string, schema: string) =>
    invoke<SchemaObjects>("list_schema_objects", { sessionId, database, schema }),

  describeTable: (sessionId: string, database: string, schema: string, table: string) =>
    invoke<TableInfo>("describe_table", { sessionId, database, schema, table }),

  schemaDiagram: (sessionId: string, database: string, schema: string) =>
    invoke<SchemaDiagram>("schema_diagram", { sessionId, database, schema }),

  /** Writes an exported diagram; the backend only takes SVG into a .svg path. */
  saveSvg: (path: string, contents: string) => invoke<void>("save_svg", { path, contents }),

  objectDefinition: (
    sessionId: string,
    database: string,
    schema: string,
    name: string,
    kind: "table" | "function" | "sequence" | "type",
    functionOid: number | null = null,
  ) => invoke<string>("object_definition", { sessionId, database, schema, name, kind, functionOid }),

  browseTable: (
    sessionId: string,
    database: string,
    schema: string,
    table: string,
    input: BrowseInput,
    executionId: string | null = null,
  ) => invoke<BrowseResult>("browse_table", { sessionId, database, schema, table, input, executionId }),

  countRows: (
    sessionId: string,
    database: string,
    schema: string,
    table: string,
    whereClause: string | null,
    executionId: string | null = null,
  ) => invoke<number>("count_rows", { sessionId, database, schema, table, whereClause, executionId }),

  /** Runs on the tab's own connection. With `caret`, only the statement there. */
  runSql: (
    sessionId: string,
    database: string,
    tabId: string,
    sql: string,
    caret: number | null,
    rowLimit: number | null,
    executionId: string | null,
  ) => invoke<SqlRun>("run_sql", { sessionId, database, tabId, sql, caret, rowLimit, executionId }),

  /** Closes the tab's own connections; an open transaction rolls back. */
  releaseTab: (sessionId: string, tabId: string) => invoke<void>("release_tab", { sessionId, tabId }),

  tabTransaction: (sessionId: string, tabId: string) =>
    invoke<TxState>("tab_transaction", { sessionId, tabId }),

  applyEdits: (
    sessionId: string,
    database: string,
    schema: string,
    table: string,
    tabId: string,
    edits: RowEdit[],
  ) => invoke<ApplyResult>("apply_edits", { sessionId, database, schema, table, tabId, edits }),

  explainSql: (
    sessionId: string,
    database: string,
    tabId: string,
    sql: string,
    analyze: boolean,
    executionId: string | null = null,
  ) => invoke<ExplainResult>("explain_sql", { sessionId, database, tabId, sql, analyze, executionId }),

  /** Stops what runs under this execution id, on the server too. */
  cancelQuery: (executionId: string) => invoke<void>("cancel_query", { executionId }),

  /** Streams a whole query to a file. */
  exportQuery: (
    sessionId: string,
    database: string,
    sql: string,
    format: ExportFormat,
    destPath: string,
    executionId: string,
  ) => invoke<ExportSummary>("export_query", { sessionId, database, sql, format, destPath, executionId }),

  /** Writes rows already in hand to a file. */
  exportRows: (columns: ResultColumn[], rows: Row[], format: ExportFormat, destPath: string) =>
    invoke<ExportSummary>("export_rows", { columns, rows, format, destPath }),

  /** The sidebar's folder tree as stored, or null before one was saved. */
  getSidebarLayout: () => invoke<unknown>("get_sidebar_layout"),

  saveSidebarLayout: (layout: unknown) => invoke<void>("save_sidebar_layout", { layout }),

  suggestScriptPath: () => invoke<string>("suggest_script_path"),

  /** With a null path the backend picks a random name in the default folder. */
  saveScript: (path: string | null, content: string) =>
    invoke<SavedScript>("save_script", { path, content }),

  listSavedScripts: () => invoke<SavedScript[]>("list_saved_scripts"),

  readSavedScript: (path: string) => invoke<string>("read_saved_script", { path }),

  /** Finds the Claude Code and Codex CLIs on this machine. */
  assistantDetect: () => invoke<DetectedAgent[]>("assistant_detect"),

  assistantSetPolicy: (policy: AssistantPolicy) => invoke<void>("assistant_set_policy", { policy }),

  /** Binds an agent session to one database; nothing runs until a send. */
  assistantStart: (input: AssistantStartInput) =>
    invoke<{ agentSessionId: string }>("assistant_start", { input }),

  /** Starts a turn; its text and steps arrive as events. */
  assistantSend: (agentSessionId: string, text: string) =>
    invoke<void>("assistant_send", { agentSessionId, text }),

  assistantStop: (agentSessionId: string) => invoke<void>("assistant_stop", { agentSessionId }),

  assistantClose: (agentSessionId: string) => invoke<void>("assistant_close", { agentSessionId }),

  assistantAnswer: (requestId: string, choice: ApprovalChoice) =>
    invoke<void>("assistant_answer", { requestId, choice }),

  /** Where the agents run, for resuming a session in a terminal. */
  assistantWorkdir: () => invoke<string>("assistant_workdir"),
};

import type { GraphCatalog } from "../types/pg";

/** Graph and vector features (Apache AGE, pgvector, SQL/PGQ). */
export const graphApi = {
  /** Which of the features the database has, and the AGE graphs in it. */
  graphCatalog: (sessionId: string, database: string) =>
    invoke<GraphCatalog>("graph_catalog", { sessionId, database }),

  /** The property names a graph label's rows carry (a sample), for completion. */
  graphLabelProperties: (sessionId: string, database: string, graph: string, label: string, edge: boolean) =>
    invoke<string[]>("graph_label_properties", { sessionId, database, graph, label, edge }),
};
