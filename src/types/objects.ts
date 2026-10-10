/** An extension installed in a database. */
export interface ExtensionInfo {
  name: string;
  version: string;
  schema: string;
  comment: string | null;
}

/** An extension the server has files for, installed here or not. */
export interface AvailableExtension {
  name: string;
  defaultVersion: string | null;
  /** Null when it is not installed in this database. */
  installedVersion: string | null;
  schema: string | null;
  comment: string | null;
}

export type ExtensionAction =
  | { kind: "install"; schema: string | null }
  | { kind: "update" }
  | { kind: "drop"; cascade: boolean };
