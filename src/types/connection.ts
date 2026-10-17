export type ConnectionSource =
  /** A postgres:// URI or a libpq key=value string. */
  | { kind: "uri"; uri: string }
  | { kind: "manual"; host: string; port: number };

/** libpq's sslmode. */
export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

export interface TlsOptions {
  sslMode: SslMode;
  /** PEM CA certificates to trust; the system's when null. */
  caFile: string | null;
  /** PEM client certificate and its unencrypted key. */
  certFile: string | null;
  keyFile: string | null;
}

export type SshAuthMethod = "password" | "private_key" | "agent";

export interface SshTunnelOptions {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath: string | null;
  privateKeyHasPassphrase: boolean;
}

export interface ConnectionAdvancedOptions {
  appName: string | null;
  connectTimeoutMs: number | null;
  statementTimeoutMs: number | null;
  searchPath: string | null;
  /** PgBouncer / Supabase pooler in transaction mode. */
  poolerMode: boolean;
  /** Every session starts with default_transaction_read_only. */
  readOnly: boolean;
  showSystemSchemas: boolean;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  /** Identity color as #RRGGBB; null picks one from the id. */
  color?: string | null;
  source: ConnectionSource;
  database: string | null;
  username: string | null;
  hasPassword: boolean;
  tls: TlsOptions;
  sshTunnel: SshTunnelOptions | null;
  advanced: ConnectionAdvancedOptions;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionProfileInput {
  id?: string | null;
  name: string;
  color?: string | null;
  source: ConnectionSource;
  database: string | null;
  username: string | null;
  password: string | null;
  tls: TlsOptions;
  sshTunnel: SshTunnelOptions | null;
  sshPassword: string | null;
  sshKeyPassphrase: string | null;
  advanced: ConnectionAdvancedOptions;
}

export interface ConnectionProfileMeta {
  id: string;
  name: string;
  color?: string | null;
  summary: string;
  database: string | null;
  readOnly: boolean;
  /** Whether a password is saved for it. */
  hasPassword: boolean;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  serverVersion: string | null;
}

export interface ConnectionHandle {
  sessionId: string;
  serverVersion: string | null;
  /** The database the connection opened on. */
  database: string;
  readOnly: boolean;
  poolerMode: boolean;
  showSystemSchemas: boolean;
}

export interface SecretBackendInfo {
  backend: "keyring" | "encrypted_file";
  warning: string | null;
}

export interface ConnectionsExportSummary {
  exported: number;
}

/** One connection found in an import file, before anything is saved. */
export interface ConnectionImportPreview {
  /** Position in the file, passed back to select it for import. */
  index: number;
  name: string;
  /** Where it connects, credentials masked. */
  address: string;
  warning: string | null;
  /** Why it can't be imported, when it can't. */
  error: string | null;
  /** A saved connection already has this name. */
  exists: boolean;
  /** The folder it was in, as "Parent / Child". */
  folder: string | null;
  /** Which app wrote the file. */
  format: "postgresStudio" | "pgAdmin";
}

/** A connection an import saved, and the folder it came from. */
export interface ImportedConnection {
  id: string;
  folder: string | null;
}

export interface ConnectionsImportSummary {
  imported: number;
  errors: string[];
  warnings: string[];
  /** What was saved, in file order. */
  created: ImportedConnection[];
}

export function emptyTlsOptions(): TlsOptions {
  return { sslMode: "prefer", caFile: null, certFile: null, keyFile: null };
}

export function emptyAdvancedOptions(): ConnectionAdvancedOptions {
  return {
    appName: null,
    connectTimeoutMs: null,
    statementTimeoutMs: null,
    searchPath: null,
    poolerMode: false,
    readOnly: false,
    showSystemSchemas: false,
  };
}

export function emptySshTunnelOptions(): SshTunnelOptions {
  return {
    enabled: false,
    host: "",
    port: 22,
    username: "",
    authMethod: "password",
    privateKeyPath: null,
    privateKeyHasPassphrase: false,
  };
}

export function newProfileInput(): ConnectionProfileInput {
  return {
    id: null,
    name: "",
    color: null,
    source: { kind: "manual", host: "localhost", port: 5432 },
    database: "postgres",
    username: "postgres",
    password: null,
    tls: emptyTlsOptions(),
    sshTunnel: null,
    sshPassword: null,
    sshKeyPassphrase: null,
    advanced: emptyAdvancedOptions(),
  };
}

/**
 * Form input for editing a saved profile. Secrets never leave the backend,
 * so they come back blank - and saving a blank one keeps what's stored.
 */
export function profileToInput(profile: ConnectionProfile): ConnectionProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    color: profile.color ?? null,
    source: profile.source,
    database: profile.database,
    username: profile.username,
    password: null,
    tls: { ...emptyTlsOptions(), ...profile.tls },
    sshTunnel: profile.sshTunnel,
    sshPassword: null,
    sshKeyPassphrase: null,
    advanced: { ...emptyAdvancedOptions(), ...profile.advanced },
  };
}
