/** A SQL script saved to disk. */
export interface SavedScript {
  path: string;
  name: string;
  /** Milliseconds since the Unix epoch. */
  modifiedMs: number;
}
