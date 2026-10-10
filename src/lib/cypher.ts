/**
 * Cypher as Apache AGE takes it, inside the dollar-quoted body of
 * `cypher('graph', $$ ... $$)`: where those bodies are in a script, what
 * can be typed at a spot in one, the query templates the explorer opens,
 * and a tokenizer for the read-only SQL view.
 */

/** AGE's keywords. */
export const CYPHER_KEYWORDS = (
  "ALL ANALYZE AND ANY AS ASC ASCENDING BY CALL CASE COALESCE CONTAINS COUNT CREATE DELETE DESC DESCENDING DETACH DISTINCT " +
  "ELSE END ENDS EXISTS EXPLAIN FALSE IN IS LIMIT MATCH MERGE NONE NOT NULL ON OPERATOR OPTIONAL OR ORDER REDUCE REMOVE " +
  "RETURN SET SINGLE SKIP STARTS THEN TRUE UNION UNWIND VERBOSE WHEN WHERE WITH XOR YIELD"
).split(" ");

/** Keywords of two words, offered as one. */
export const CYPHER_PHRASES = ["OPTIONAL MATCH", "ORDER BY", "DETACH DELETE"];

/** The functions AGE provides. */
export const CYPHER_FUNCTIONS = (
  "id start_id end_id properties labels label type head last size keys nodes relationships range startNode endNode length " +
  "toBoolean toFloat toInteger toString toStringList toLower toUpper trim ltrim rtrim left right substring split replace reverse " +
  "abs ceil floor round sign sqrt exp log log10 sin cos tan cot asin acos atan atan2 degrees radians pi e rand timestamp isEmpty " +
  "avg sum min max count collect stDev stDevP percentileCont percentileDisc coalesce exists"
).split(" ");

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A Cypher name, in backticks when it isn't a plain identifier. */
export function cypherIdent(name: string): string {
  return IDENT.test(name) ? name : `\`${name.replace(/`/g, "``")}\``;
}

/** A SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** What each session needs before cypher() works. */
export const AGE_SETUP = `LOAD 'age';\nSET search_path = ag_catalog, "$user", public;`;

/** `$$`, or a tagged quote when the body itself holds `$$`. */
function quoteTag(body: string): string {
  let tag = "$$";
  for (let n = 0; body.includes(tag); n++) tag = `$cypher${n || ""}$`;
  return tag;
}

/** A cypher() call returning `columns` as agtype. */
export function cypherQuery(graph: string, body: string, columns: string[]): string {
  const tag = quoteTag(body);
  return `SELECT * FROM cypher(${sqlString(graph)}, ${tag} ${body} ${tag}) AS (${columns.map((c) => `${c} agtype`).join(", ")});`;
}

/** A console's text for a new query on a graph. */
export function graphScript(graph: string): string {
  return `${AGE_SETUP}\n\n${cypherQuery(graph, "MATCH (n) RETURN n LIMIT 25", ["n"])}\n`;
}

/** A console's text for the nodes of a vertex label, or the edges of an edge label. */
export function labelScript(graph: string, label: string, kind: "v" | "e"): string {
  const name = cypherIdent(label);
  const query =
    kind === "v"
      ? cypherQuery(graph, `MATCH (n:${name}) RETURN n LIMIT 25`, ["n"])
      : cypherQuery(graph, `MATCH (a)-[e:${name}]->(b) RETURN a, e, b LIMIT 25`, ["a", "e", "b"]);
  return `${AGE_SETUP}\n\n${query}\n`;
}

/** A console's text for a SQL/PGQ property graph, whose columns only its author knows. */
export function propertyGraphScript(schema: string, name: string): string {
  const q = (n: string) => (IDENT.test(n) && n === n.toLowerCase() ? n : `"${n.replace(/"/g, '""')}"`);
  return `-- SQL/PGQ: name the columns to return from the graph's vertices and edges.\nSELECT *\nFROM GRAPH_TABLE (${q(schema)}.${q(name)}\n  MATCH (a)-[e]->(b)\n  COLUMNS (a.id AS from_id, b.id AS to_id)\n);\n`;
}

// ------------------------------------------------------------ finding Cypher in SQL

export interface CypherBody {
  /** The graph the call names. */
  graph: string;
  /** Offsets in the script: the body is `text.slice(start, end)`. */
  start: number;
  end: number;
  /** The closing `$$` is there; otherwise the body runs to the end. */
  closed: boolean;
}

const CALL = /\bcypher\s*\(\s*(?:'((?:[^']|'')*)'|"([^"]*)")\s*,\s*(\$[A-Za-z_]*\$)/gi;

/** The `cypher('graph', $$ ... $$)` bodies of a script, in order. */
export function findCypherBodies(text: string): CypherBody[] {
  const out: CypherBody[] = [];
  CALL.lastIndex = 0;
  for (let m = CALL.exec(text); m; m = CALL.exec(text)) {
    const start = m.index + m[0].length;
    const close = text.indexOf(m[3], start);
    out.push({ graph: (m[1] ?? m[2]).replace(/''/g, "'"), start, end: close < 0 ? text.length : close, closed: close >= 0 });
    if (close < 0) break;
    CALL.lastIndex = close + m[3].length;
  }
  return out;
}

/** The body the caret (a character offset) is in, if any. */
export function cypherBodyAt(text: string, offset: number): CypherBody | null {
  return findCypherBodies(text).find((b) => offset >= b.start && offset <= b.end) ?? null;
}

// ------------------------------------------------------------ what can be typed here

export type CypherSpot =
  /** After `(n:` or `(:`: a vertex label. */
  | { kind: "vertexLabel" }
  /** After `[e:` or `[:`: an edge label. */
  | { kind: "edgeLabel" }
  /** After `n.` or inside `{` of a labeled pattern: a property of that label, if the label is known. */
  | { kind: "property"; label: string | null; edge: boolean }
  | { kind: "general" };

/** Where in a Cypher body the caret is, from the body's text up to it. */
export function cypherSpot(before: string): CypherSpot {
  const label = /([(\[])\s*[A-Za-z_]\w*?\s*:\s*[A-Za-z_]*$|([(\[])\s*:\s*[A-Za-z_]*$/.exec(before);
  if (label) return (label[1] ?? label[2]) === "(" ? { kind: "vertexLabel" } : { kind: "edgeLabel" };

  // the map of a pattern: (n:Person {na|  -> properties of Person
  const open = before.lastIndexOf("{");
  if (open >= 0 && !before.slice(open).includes("}") && /(?:^|[{,])\s*[\w"']*$/.test(before.slice(open))) {
    const head = /([(\[])\s*(?:[A-Za-z_]\w*)?\s*:\s*(`[^`]+`|[A-Za-z_]\w*)\s*$/.exec(before.slice(0, open));
    if (head) return { kind: "property", label: head[2].replace(/^`|`$/g, ""), edge: head[1] === "[" };
  }

  // n.na|  -> properties of whatever label n was given in the body
  const dotted = /([A-Za-z_]\w*)\.[A-Za-z_]*$/.exec(before);
  if (dotted) {
    const bound = new RegExp(`([(\\[])\\s*${dotted[1]}\\s*:\\s*(\`[^\`]+\`|[A-Za-z_]\\w*)`).exec(before);
    return { kind: "property", label: bound ? bound[2].replace(/^`|`$/g, "") : null, edge: bound ? bound[1] === "[" : false };
  }
  return { kind: "general" };
}

// ------------------------------------------------------------ tokenizer for the read-only view

export interface CypherToken {
  text: string;
  /** Tailwind classes, or null for plain text; the colors SqlText uses. */
  cls: string | null;
}

const KEYWORD_SET = new Set(CYPHER_KEYWORDS.map((k) => k.toLowerCase()));

/** Cypher highlighted with the same colors as the SQL around it. */
export function tokenizeCypher(text: string): CypherToken[] {
  const re =
    /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(`[^`]*`)|(\$[A-Za-z_]\w*)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(:\s*)([A-Za-z_]\w*)|([A-Za-z_]\w*)(\s*\()?/g;
  const out: CypherToken[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), cls: null });
    const [whole, line, block, str, quoted, param, num, colon, label, word, paren] = m;
    if (line || block) out.push({ text: whole, cls: "text-code-comment italic" });
    else if (str) out.push({ text: whole, cls: "text-json-string" });
    else if (quoted) out.push({ text: whole, cls: "text-fg" });
    else if (param) out.push({ text: whole, cls: "text-json-bson" });
    else if (num) out.push({ text: whole, cls: "text-json-number" });
    else if (label) {
      // a name after a colon is a label; in a map it would be a bare value, which is rare
      out.push({ text: colon, cls: null }, { text: label, cls: KEYWORD_SET.has(label.toLowerCase()) ? "text-json-keyword" : "text-json-bson" });
    } else if (word) {
      const lower = word.toLowerCase();
      out.push({ text: word, cls: KEYWORD_SET.has(lower) ? "text-json-keyword" : paren ? "text-json-bson" : null });
      if (paren) out.push({ text: paren, cls: null });
    }
    last = m.index + whole.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), cls: null });
  return out;
}
