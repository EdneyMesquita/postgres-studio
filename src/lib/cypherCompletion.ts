import type { GraphInfo } from "../types/pg";
import { CYPHER_FUNCTIONS, CYPHER_KEYWORDS, CYPHER_PHRASES, cypherIdent } from "./cypher";
import type { CypherSpot } from "./cypher";

/** A completion before it is dressed for Monaco. */
export interface CypherCandidate {
  label: string;
  insertText: string;
  kind: "keyword" | "function" | "vertexLabel" | "edgeLabel" | "property";
  detail?: string;
  sortText: string;
}

/**
 * What to offer at a spot of a Cypher body: labels of the graph after a
 * colon, properties of a known label after a dot or inside a pattern's map,
 * and keywords and functions anywhere else. `properties` are the names
 * sampled from the label's rows, when asked for.
 */
export function cypherCandidates(spot: CypherSpot, graph: GraphInfo | null, properties: string[]): CypherCandidate[] {
  switch (spot.kind) {
    case "vertexLabel":
    case "edgeLabel": {
      const kind = spot.kind === "vertexLabel" ? "v" : "e";
      return (graph?.labels ?? [])
        .filter((l) => l.kind === kind)
        .map((l) => ({
          label: l.name,
          insertText: cypherIdent(l.name),
          kind: spot.kind,
          detail: `${graph!.name} · ${kind === "v" ? "vertex" : "edge"} label`,
          sortText: `0${l.name}`,
        }));
    }
    case "property":
      return properties.map((name) => ({
        label: name,
        insertText: cypherIdent(name),
        kind: "property" as const,
        detail: spot.label ? `${spot.label} property` : "property",
        sortText: `0${name}`,
      }));
    case "general":
      return [
        ...CYPHER_KEYWORDS.map((k) => ({ label: k, insertText: k, kind: "keyword" as const, sortText: `1${k}` })),
        ...CYPHER_PHRASES.map((k) => ({ label: k, insertText: k, kind: "keyword" as const, sortText: `1${k}` })),
        ...CYPHER_FUNCTIONS.map((f) => ({ label: f, insertText: `${f}(`, kind: "function" as const, sortText: `2${f}` })),
      ];
  }
}

const propertyCache = new Map<string, Promise<string[]>>();

/** Property names of a label, asked of the server once per graph and label. */
export function cachedProperties(key: string, load: () => Promise<string[]>): Promise<string[]> {
  let found = propertyCache.get(key);
  if (!found) {
    found = load().catch(() => {
      // retried at the next completion: the library may load once the user has run the setup
      propertyCache.delete(key);
      return [];
    });
    propertyCache.set(key, found);
  }
  return found;
}

/** Forgets sampled property names, e.g. after the graph changed. */
export function clearPropertyCache() {
  propertyCache.clear();
}
