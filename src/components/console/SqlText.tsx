import { Fragment, useMemo } from "react";
import { cn } from "@/lib/utils";
import { tokenizeCypher } from "@/lib/cypher";

const KEYWORDS = new Set(
  (
    "select from where join left right inner outer full cross on and or not as with group by order desc asc limit offset " +
    "having interval insert into values update set delete begin commit rollback create table primary key references " +
    "unique check default null is in case when then else end distinct returning index concurrently using constraint " +
    "foreign exists true false view materialized function procedure trigger before after for each row execute " +
    "returns language replace alter drop add column type enum schema sequence grant revoke on to cascade restrict " +
    "nulls first last union all except intersect lateral over partition window filter within like ilike between " +
    "do if loop return declare perform raise notice explain analyze verbose buffers format json truncate vacuum " +
    "comment generated always identity stored owned cycle increment minvalue maxvalue start cache temporary temp graph_table match"
  ).split(" "),
);

const TYPES = new Set(
  (
    "int int2 int4 int8 smallint integer bigint serial bigserial text varchar char character numeric decimal real " +
    "double precision float4 float8 bool boolean date time timestamp timestamptz interval uuid json jsonb bytea inet " +
    "cidr macaddr money citext tsvector point"
  ).split(" "),
);

type Token = { text: string; cls: string | null };

/** What comes right before the quote of a `cypher('graph', $$ ... $$)` body. */
const CYPHER_CALL = /\bcypher\s*\(\s*(?:'(?:[^']|'')*'|"[^"]*")\s*,\s*$/i;
const STRING = "text-json-string";

/** A small SQL tokenizer for read-only display: comments, strings, numbers, keywords. */
export function tokenizeSql(text: string): Token[] {
  const re = /(--[^\n]*)|(\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*")|(\$[a-zA-Z_]*\$[\s\S]*?\$[a-zA-Z_]*\$)|(\b\d+(?:\.\d+)?\b)|(\bproperty\s+graph\b)|([a-zA-Z_][a-zA-Z0-9_]*)(\s*\()?/gi;
  const out: Token[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), cls: null });
    const [whole, line, block, str, quoted, dollar, num, propertyGraph, word, paren] = m;
    if (line || block) out.push({ text: whole, cls: "text-code-comment italic" });
    else if (dollar && CYPHER_CALL.test(text.slice(Math.max(0, m.index - 300), m.index))) {
      // the body of a cypher() call is Cypher, between its quotes
      const open = /^\$[a-zA-Z_]*\$/.exec(whole)![0];
      const close = /\$[a-zA-Z_]*\$$/.exec(whole.slice(open.length))?.[0] ?? "";
      out.push({ text: open, cls: STRING }, ...tokenizeCypher(whole.slice(open.length, whole.length - close.length)));
      if (close) out.push({ text: close, cls: STRING });
    } else if (str || dollar) out.push({ text: whole, cls: STRING });
    else if (quoted) out.push({ text: whole, cls: "text-fg" });
    else if (num) out.push({ text: whole, cls: "text-json-number" });
    else if (propertyGraph) out.push({ text: whole, cls: "text-json-keyword" });
    else if (word) {
      const lower = word.toLowerCase();
      // SQL/PGQ's COLUMNS (...) is a keyword; as a bare name it is not
      const cls = KEYWORDS.has(lower) || (lower === "columns" && paren) ? "text-json-keyword" : TYPES.has(lower) ? "text-json-bson" : paren ? "text-json-bson" : null;
      out.push({ text: word, cls });
      if (paren) out.push({ text: paren, cls: null });
    }
    last = m.index + whole.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), cls: null });
  return out;
}

/** Highlighted SQL, read-only, in the data font. */
export function SqlText({ text, className }: { text: string; className?: string }) {
  const tokens = useMemo(() => tokenizeSql(text), [text]);
  return (
    <pre className={cn("m-0 font-data whitespace-pre-wrap break-words text-fg", className)}>
      {tokens.map((t, i) => (t.cls ? <span key={i} className={t.cls}>{t.text}</span> : <Fragment key={i}>{t.text}</Fragment>))}
    </pre>
  );
}
