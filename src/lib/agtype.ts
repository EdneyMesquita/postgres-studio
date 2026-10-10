/**
 * Apache AGE's `agtype`, as the server prints it: JSON whose graph values
 * carry a type suffix - `{...}::vertex`, `{...}::edge`, `[v, e, v]::path` -
 * and whose decimal numbers may carry `::numeric`. The parser keeps the
 * suffix and the digits of every number as written: vertex and edge ids are
 * 64-bit, past what a JS number holds exactly.
 */

export type AgValue =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  /** `raw` is the number as the server wrote it. */
  | { t: "num"; raw: string }
  | { t: "str"; v: string }
  | { t: "arr"; items: AgValue[]; suffix: string | null }
  | { t: "obj"; entries: [string, AgValue][]; suffix: string | null };

/** Whether a result column holds agtype. */
export function isAgtype(typeName: string): boolean {
  return typeName === "agtype";
}

class Reader {
  pos = 0;
  constructor(readonly text: string) {}

  fail(): never {
    throw new SyntaxError(`agtype: unexpected input at ${this.pos}`);
  }

  space() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  value(): AgValue {
    this.space();
    const c = this.text[this.pos];
    let v: AgValue;
    if (c === "{") v = this.object();
    else if (c === "[") v = this.array();
    else if (c === '"') v = { t: "str", v: this.string() };
    else if (this.text.startsWith("true", this.pos)) ((this.pos += 4), (v = { t: "bool", v: true }));
    else if (this.text.startsWith("false", this.pos)) ((this.pos += 5), (v = { t: "bool", v: false }));
    else if (this.text.startsWith("null", this.pos)) ((this.pos += 4), (v = { t: "null" }));
    else v = this.number();
    return this.suffix(v);
  }

  /** `::vertex` and friends after a value. */
  suffix(v: AgValue): AgValue {
    const m = /^::([a-z]+)/.exec(this.text.slice(this.pos, this.pos + 16));
    if (!m) return v;
    this.pos += m[0].length;
    if ((v.t === "obj" || v.t === "arr") && m[1] !== "numeric") return { ...v, suffix: m[1] };
    return v;
  }

  number(): AgValue {
    const m = /^-?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|Infinity|NaN)/.exec(this.text.slice(this.pos, this.pos + 400));
    if (!m) this.fail();
    this.pos += m[0].length;
    return { t: "num", raw: m[0] };
  }

  string(): string {
    const start = this.pos;
    this.pos++;
    while (this.pos < this.text.length && this.text[this.pos] !== '"') this.pos += this.text[this.pos] === "\\" ? 2 : 1;
    if (this.text[this.pos] !== '"') this.fail();
    this.pos++;
    try {
      return JSON.parse(this.text.slice(start, this.pos)) as string;
    } catch {
      return this.fail();
    }
  }

  array(): AgValue {
    this.pos++;
    const items: AgValue[] = [];
    this.space();
    if (this.text[this.pos] === "]") return (this.pos++, { t: "arr", items, suffix: null });
    for (;;) {
      items.push(this.value());
      this.space();
      const c = this.text[this.pos++];
      if (c === "]") return { t: "arr", items, suffix: null };
      if (c !== ",") this.fail();
    }
  }

  object(): AgValue {
    this.pos++;
    const entries: [string, AgValue][] = [];
    this.space();
    if (this.text[this.pos] === "}") return (this.pos++, { t: "obj", entries, suffix: null });
    for (;;) {
      this.space();
      if (this.text[this.pos] !== '"') this.fail();
      const key = this.string();
      this.space();
      if (this.text[this.pos++] !== ":") this.fail();
      entries.push([key, this.value()]);
      this.space();
      const c = this.text[this.pos++];
      if (c === "}") return { t: "obj", entries, suffix: null };
      if (c !== ",") this.fail();
    }
  }
}

/** The value of an agtype text, or null when it isn't one. */
export function parseAgtype(text: string): AgValue | null {
  try {
    const reader = new Reader(text);
    const v = reader.value();
    reader.space();
    return reader.pos === text.length ? v : null;
  } catch {
    return null;
  }
}

function field(v: AgValue, key: string): AgValue | undefined {
  return v.t === "obj" ? v.entries.find(([k]) => k === key)?.[1] : undefined;
}

const isVertex = (v: AgValue) => v.t === "obj" && v.suffix === "vertex";
const isEdge = (v: AgValue) => v.t === "obj" && v.suffix === "edge";

/** A JSON-like literal, compactly. Keys are bare, as in Cypher maps. */
function literal(v: AgValue): string {
  switch (v.t) {
    case "null":
      return "null";
    case "bool":
      return String(v.v);
    case "num":
      return v.raw;
    case "str":
      return JSON.stringify(v.v);
    case "arr":
      return v.suffix === "path" ? path(v) : `[${v.items.map(compact).join(", ")}]`;
    case "obj":
      return map(v.entries);
  }
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function map(entries: [string, AgValue][]): string {
  return `{${entries.map(([k, x]) => `${KEY.test(k) ? k : JSON.stringify(k)}: ${compact(x)}`).join(", ")}}`;
}

function labelOf(v: AgValue): string {
  const label = field(v, "label");
  return label?.t === "str" && label.v !== "" ? `:${label.v}` : "";
}

function propsOf(v: AgValue): string {
  const props = field(v, "properties");
  return props?.t === "obj" && props.entries.length > 0 ? ` ${map(props.entries)}` : "";
}

/** `(a)-[:R]->(b)`: vertices by label, edges drawn toward where they point. */
function path(v: AgValue & { t: "arr" }): string {
  const parts: string[] = [];
  let previous: string | null = null;
  for (const el of v.items) {
    if (isEdge(el)) {
      const start = field(el, "start_id");
      const forward = previous === null || start?.t !== "num" || start.raw === previous;
      const body = `[${labelOf(el)}]`;
      parts.push(forward ? `-${body}->` : `<-${body}-`);
    } else if (isVertex(el)) {
      const id = field(el, "id");
      previous = id?.t === "num" ? id.raw : null;
      parts.push(`(${labelOf(el)})`);
    } else {
      parts.push(compact(el));
    }
  }
  return parts.join("");
}

/** One agtype value as a single line: graph values in Cypher's own notation. */
export function compact(v: AgValue): string {
  if (v.t === "obj" && v.suffix === "vertex") return `(${labelOf(v)}${propsOf(v)})`;
  if (v.t === "obj" && v.suffix === "edge") return `[${labelOf(v)}${propsOf(v)}]`;
  return literal(v);
}

/** What a grid cell shows: `(:Person {name: "Ann"})`, `[:KNOWS]`, `(:A)-[:R]->(:B)`. */
export function agtypeSummary(text: string): string {
  const v = parseAgtype(text);
  return v ? compact(v) : text;
}

/** The value as JSON for the inspector: suffixes dropped, numbers as written. */
function json(v: AgValue, indent: string): string {
  const inner = `${indent}  `;
  switch (v.t) {
    case "arr":
      return v.items.length === 0 ? "[]" : `[\n${v.items.map((x) => inner + json(x, inner)).join(",\n")}\n${indent}]`;
    case "obj":
      return v.entries.length === 0
        ? "{}"
        : `{\n${v.entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${json(x, inner)}`).join(",\n")}\n${indent}}`;
    case "str":
      return JSON.stringify(v.v);
    case "num":
      // JSON has no NaN or Infinity; keep them readable as strings
      return /^-?\d/.test(v.raw) ? v.raw : JSON.stringify(v.raw);
    default:
      return literal(v);
  }
}

/** Pretty JSON for the inspector, or the text as is when it isn't agtype. */
export function prettyAgtype(text: string): string {
  const v = parseAgtype(text);
  return v ? json(v, "") : text;
}
