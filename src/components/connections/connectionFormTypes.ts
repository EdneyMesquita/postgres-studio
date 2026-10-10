import type { ConnectionProfile, ConnectionProfileInput } from "../../types/connection";

export type ConnectionSection = "general" | "tls" | "ssh" | "advanced";

export type UpdateInput = <K extends keyof ConnectionProfileInput>(
  key: K,
  value: ConnectionProfileInput[K],
) => void;

/** What every section of the connection form gets. */
export interface ConnectionSectionProps {
  input: ConnectionProfileInput;
  update: UpdateInput;
  /** The saved profile being edited, for its "secret is saved" flags. */
  editing?: ConnectionProfile;
}

/** Placeholder for a secret field when editing: blank keeps the saved one. */
export const KEEP_SAVED = "Saved - leave blank to keep";

/** A number field's value, or null when it's empty. */
export function numberOrNull(text: string): number | null {
  return text ? Number(text) : null;
}

/** Fields holding data (hosts, URIs, names) are mono; their hints aren't. text-data
 * so the merge drops the field's text-base, which would beat font-data. */
export const DATA_FIELD = "font-data text-data placeholder:font-sans";
