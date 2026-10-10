/**
 * pgvector's types as the server prints them: `vector` and `halfvec` as
 * `[0.1,0.2,0.3]`, `sparsevec` as `{1:0.5,3:2}/5` (1-based positions, then
 * the dimension count). The type name reaches the UI in two spellings -
 * `vector(1536)` from a table's columns, bare `vector` from a query's
 * result - so the dimension count is read from the value when it must be.
 */

export type VectorType = "vector" | "halfvec" | "sparsevec";

const TYPE = /^(vector|halfvec|sparsevec)(?:\((\d+)\))?$/;

/** The vector type a column has and the dimensions its modifier fixes, if any. */
export function vectorType(typeName: string): { type: VectorType; dims: number | null } | null {
  const m = TYPE.exec(typeName.trim());
  return m ? { type: m[1] as VectorType, dims: m[2] ? Number(m[2]) : null } : null;
}

/** How many components a dense vector's text has, without parsing them. */
export function denseDims(text: string): number {
  const t = text.trim();
  if (t === "[]") return 0;
  let commas = 0;
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 44) commas++;
  return commas + 1;
}

/** A component to three significant digits, trailing zeros dropped. */
export function shortNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(Number(n.toPrecision(3)));
}

export interface VectorSummary {
  /** The first components, cut with … when more follow. */
  head: string;
  /** What the grid shows beside it: `1536d`, or `2 nnz · 5d` for a sparse one. */
  tag: string;
  dims: number;
}

const HEAD = 4;

export function sparseParts(text: string): { entries: [string, string][]; dims: number } | null {
  const m = /^\{([^}]*)\}\/(\d+)$/.exec(text.trim());
  if (!m) return null;
  const entries = m[1].trim() === "" ? [] : m[1].split(",").map((e) => e.trim().split(":") as [string, string]);
  return { entries, dims: Number(m[2]) };
}

/** The grid's view of a vector cell, or null when the text isn't one. */
export function vectorSummary(type: VectorType, text: string): VectorSummary | null {
  if (type === "sparsevec") {
    const parts = sparseParts(text);
    if (!parts) return null;
    const shown = parts.entries.slice(0, HEAD).map(([i, v]) => `${i}:${shortNumber(v)}`);
    const more = parts.entries.length > HEAD ? ", …" : "";
    return { head: `{${shown.join(", ")}${more}}`, tag: `${parts.entries.length} nnz · ${parts.dims}d`, dims: parts.dims };
  }
  const t = text.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return null;
  const dims = denseDims(t);
  // only the front is split: a 16000-dimension vector costs no more than a short one
  const front = dims > HEAD ? t.slice(1, nthComma(t, HEAD)) : t.slice(1, -1);
  const shown = front === "" ? [] : front.split(",").map((c) => shortNumber(c.trim()));
  return { head: `[${shown.join(", ")}${dims > HEAD ? ", …" : ""}]`, tag: `${dims}d`, dims };
}

function nthComma(text: string, n: number): number {
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 44 && ++seen === n) return i;
  }
  return text.length - 1;
}

/** The inspector's view: the whole value, one line per few components so it wraps cleanly. */
export function vectorBlock(type: VectorType, text: string): { text: string; tag: string } | null {
  const summary = vectorSummary(type, text);
  if (!summary) return null;
  return { text: text.trim().replace(/,/g, ", "), tag: summary.tag };
}

/** `vector(3)` for the edit field's hint: what the column takes. */
export function vectorHint(typeName: string): string | null {
  const v = vectorType(typeName);
  if (!v) return null;
  if (v.type === "sparsevec") return v.dims ? `{index:value,…}/${v.dims}` : "{index:value,…}/dimensions";
  return v.dims ? `[${v.dims} numbers]` : "[numbers]";
}

// ------------------------------------------------------------ operators and indexes

export interface VectorOperator {
  op: string;
  name: string;
  detail: string;
}

/** pgvector 0.8's distance operators; ordering by them ascending is nearest first. */
export const VECTOR_OPERATORS: VectorOperator[] = [
  { op: "<->", name: "L2 distance", detail: "Euclidean distance; vector, halfvec, sparsevec" },
  { op: "<#>", name: "negative inner product", detail: "multiplied by -1 so ORDER BY ASC works; vector, halfvec, sparsevec" },
  { op: "<=>", name: "cosine distance", detail: "1 - cosine similarity; vector, halfvec, sparsevec" },
  { op: "<+>", name: "L1 distance", detail: "taxicab distance; vector, halfvec, sparsevec" },
  { op: "<~>", name: "Hamming distance", detail: "bits that differ; bit" },
  { op: "<%>", name: "Jaccard distance", detail: "bit" },
];

export interface OpClass {
  name: string;
  /** The column types it indexes. */
  types: string[];
  detail: string;
  /** Index methods that support it. */
  methods: ("hnsw" | "ivfflat")[];
}

export const OPCLASSES: OpClass[] = [
  { name: "vector_l2_ops", types: ["vector"], detail: "L2 distance (<->)", methods: ["hnsw", "ivfflat"] },
  { name: "vector_ip_ops", types: ["vector"], detail: "inner product (<#>)", methods: ["hnsw", "ivfflat"] },
  { name: "vector_cosine_ops", types: ["vector"], detail: "cosine distance (<=>)", methods: ["hnsw", "ivfflat"] },
  { name: "vector_l1_ops", types: ["vector"], detail: "L1 distance (<+>)", methods: ["hnsw"] },
  { name: "halfvec_l2_ops", types: ["halfvec"], detail: "L2 distance (<->)", methods: ["hnsw", "ivfflat"] },
  { name: "halfvec_ip_ops", types: ["halfvec"], detail: "inner product (<#>)", methods: ["hnsw", "ivfflat"] },
  { name: "halfvec_cosine_ops", types: ["halfvec"], detail: "cosine distance (<=>)", methods: ["hnsw", "ivfflat"] },
  { name: "halfvec_l1_ops", types: ["halfvec"], detail: "L1 distance (<+>)", methods: ["hnsw"] },
  { name: "sparsevec_l2_ops", types: ["sparsevec"], detail: "L2 distance (<->)", methods: ["hnsw"] },
  { name: "sparsevec_ip_ops", types: ["sparsevec"], detail: "inner product (<#>)", methods: ["hnsw"] },
  { name: "sparsevec_cosine_ops", types: ["sparsevec"], detail: "cosine distance (<=>)", methods: ["hnsw"] },
  { name: "sparsevec_l1_ops", types: ["sparsevec"], detail: "L1 distance (<+>)", methods: ["hnsw"] },
  { name: "bit_hamming_ops", types: ["bit"], detail: "Hamming distance (<~>)", methods: ["hnsw", "ivfflat"] },
  { name: "bit_jaccard_ops", types: ["bit"], detail: "Jaccard distance (<%>)", methods: ["hnsw", "ivfflat"] },
];

/** The base type of a column type name: `vector(3)` is vector, `bit(64)` is bit. */
export function baseType(typeName: string): string {
  return typeName.replace(/\(.*$/, "").trim().toLowerCase();
}

/** The opclasses the method supports for the column's type; all of them when the type is unknown. */
export function opclassesFor(method: "hnsw" | "ivfflat", columnType: string | null): OpClass[] {
  const base = columnType ? baseType(columnType) : null;
  const supported = OPCLASSES.filter((o) => o.methods.includes(method));
  const known = base !== null && supported.some((o) => o.types.includes(base));
  return known ? supported.filter((o) => o.types.includes(base)) : supported;
}

export interface IndexContext {
  method: "hnsw" | "ivfflat";
  /** The table named after ON, as written (maybe schema-qualified). */
  table: string | null;
  column: string;
}

/**
 * Whether the text before the caret is `CREATE INDEX ... USING hnsw (col `,
 * the spot an operator class goes, and which column and table it is on.
 */
export function indexContextAt(before: string): IndexContext | null {
  const using = /\busing\s+(hnsw|ivfflat)\s*\(\s*("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s+[\w]*$/i.exec(before);
  if (!using) return null;
  const head = before.slice(0, using.index);
  const on = /\bon\s+(?:only\s+)?((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)\s*$/i.exec(head);
  // the statement the clause belongs to starts at the last semicolon
  const statement = head.slice(head.lastIndexOf(";") + 1);
  if (!/\bcreate\s+(?:unique\s+)?index\b/i.test(statement)) return null;
  return { method: using[1].toLowerCase() as "hnsw" | "ivfflat", table: on ? on[1].replace(/\s+/g, "") : null, column: using[2] };
}

/** pgvector's functions, with the signature each takes. */
export const VECTOR_FUNCTIONS: { name: string; detail: string }[] = [
  { name: "l2_distance", detail: "(a, b) → double precision" },
  { name: "cosine_distance", detail: "(a, b) → double precision" },
  { name: "inner_product", detail: "(a, b) → double precision" },
  { name: "l1_distance", detail: "(a, b) → double precision" },
  { name: "hamming_distance", detail: "(a bit, b bit) → double precision" },
  { name: "jaccard_distance", detail: "(a bit, b bit) → double precision" },
  { name: "vector_dims", detail: "(v) → integer" },
  { name: "vector_norm", detail: "(v) → double precision" },
  { name: "l2_normalize", detail: "(v) → same type" },
  { name: "binary_quantize", detail: "(v) → bit" },
  { name: "subvector", detail: "(v, start, length) → same type" },
];
