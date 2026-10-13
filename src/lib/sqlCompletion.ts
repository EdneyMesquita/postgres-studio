import type * as Monaco from "monaco-editor";
import { api, graphApi } from "./tauri";
import { useExplorerStore } from "../store/explorerStore";
import { useGraphStore } from "../store/graphStore";
import { cypherBodyAt, cypherSpot } from "./cypher";
import { cachedProperties, cypherCandidates } from "./cypherCompletion";
import { indexContextAt, opclassesFor, VECTOR_FUNCTIONS, VECTOR_OPERATORS } from "./pgvector";
import { TIMESCALE_FUNCTIONS } from "./timescale";
import type { ColumnInfo, RelationEntry, SchemaObjects } from "../types/pg";

/** The console's SQL language: PostgreSQL's, with Cypher inside cypher() calls (see studioLanguages). */
export const SQL_LANGUAGE = "postgres-studio-sql";

/** Where an editor's SQL runs: what its completion lists come from. */
export interface SqlContext {
  sessionId: string;
  connectionId: string;
  database: string;
}

const contexts = new Map<string, () => SqlContext | null>();
const columnCache = new Map<string, Promise<ColumnInfo[]>>();

const KEYWORDS = (
  "SELECT FROM WHERE AND OR NOT NULL IS IN LIKE ILIKE BETWEEN EXISTS JOIN LEFT RIGHT INNER FULL OUTER CROSS LATERAL ON USING " +
  "GROUP BY ORDER ASC DESC NULLS FIRST LAST HAVING LIMIT OFFSET DISTINCT AS WITH RECURSIVE UNION ALL EXCEPT INTERSECT CASE WHEN THEN ELSE END " +
  "INSERT INTO VALUES DEFAULT RETURNING UPDATE SET DELETE TRUNCATE BEGIN COMMIT ROLLBACK SAVEPOINT CREATE TABLE VIEW MATERIALIZED INDEX UNIQUE " +
  "PRIMARY KEY FOREIGN REFERENCES CHECK CONSTRAINT ALTER ADD COLUMN DROP RENAME TO CASCADE RESTRICT IF FUNCTION PROCEDURE RETURNS LANGUAGE " +
  "TRIGGER SCHEMA SEQUENCE TYPE ENUM EXPLAIN ANALYZE VERBOSE BUFFERS VACUUM GRANT REVOKE COMMENT FILTER OVER PARTITION WINDOW COALESCE NULLIF " +
  "CAST INTERVAL TRUE FALSE ON CONFLICT DO NOTHING GRAPH_TABLE MATCH COLUMNS PROPERTY GRAPH"
).split(" ");

const FUNCTIONS = (
  "count sum avg min max now current_date current_timestamp date_trunc extract to_char to_date coalesce nullif greatest least " +
  "length lower upper trim substring replace concat string_agg array_agg json_agg jsonb_agg json_build_object jsonb_build_object " +
  "jsonb_set jsonb_extract_path_text row_number rank dense_rank lag lead generate_series round floor ceil abs random gen_random_uuid " +
  "pg_size_pretty pg_total_relation_size age split_part regexp_replace unnest"
).split(" ");

/** Lets completion know which database an editor's text runs on. */
export function attachSqlCompletion(model: Monaco.editor.ITextModel, context: () => SqlContext | null): () => void {
  const uri = model.uri.toString();
  contexts.set(uri, context);
  return () => contexts.delete(uri);
}

function objectsOf(ctx: SqlContext): { schema: string; objects: SchemaObjects }[] {
  const { schemas } = useExplorerStore.getState();
  const prefix = `${ctx.connectionId}/${ctx.database}/`;
  return Object.entries(schemas)
    .filter(([key, node]) => key.startsWith(prefix) && node.objects)
    .map(([key, node]) => ({ schema: key.slice(prefix.length), objects: node.objects! }));
}

function columnsOf(ctx: SqlContext, schema: string, table: string): Promise<ColumnInfo[]> {
  const key = `${ctx.sessionId}/${ctx.database}/${schema}.${table}`;
  let found = columnCache.get(key);
  if (!found) {
    found = api
      .describeTable(ctx.sessionId, ctx.database, schema, table)
      .then((info) => info.columns)
      .catch(() => {
        columnCache.delete(key);
        return [];
      });
    columnCache.set(key, found);
  }
  return found;
}

/** What the explorer knows of the database's graphs and extensions, read when it opened. */
function graphCatalogOf(ctx: SqlContext) {
  return useGraphStore.getState().nodes[`${ctx.connectionId}/${ctx.database}`]?.catalog ?? null;
}

type Dressed = Monaco.languages.CompletionItem;

/** Completion inside the Cypher body of a cypher('graph', $$ ... $$) call. */
async function cypherSuggestions(
  monaco: typeof Monaco,
  ctx: SqlContext | null,
  graphName: string,
  bodyBefore: string,
  triggerCharacter: string | undefined,
  range: Monaco.IRange,
): Promise<Dressed[]> {
  const { CompletionItemKind: Kind } = monaco.languages;
  const spot = cypherSpot(bodyBefore);
  // a colon, dot or angle bracket typed outside a place that takes a name has nothing to offer
  if (triggerCharacter && spot.kind === "general") return [];
  const graph = (ctx && graphCatalogOf(ctx)?.graphs.find((g) => g.name === graphName)) || null;
  let properties: string[] = [];
  if (spot.kind === "property" && ctx && spot.label && graph) {
    const label = spot.label;
    properties = await cachedProperties(`${ctx.sessionId}/${ctx.database}/${graphName}/${spot.edge ? "e" : "v"}/${label}`, () =>
      graphApi.graphLabelProperties(ctx.sessionId, ctx.database, graphName, label),
    );
  }
  const kinds = {
    keyword: Kind.Keyword,
    function: Kind.Function,
    vertexLabel: Kind.Class,
    edgeLabel: Kind.Interface,
    property: Kind.Field,
  };
  return cypherCandidates(spot, graph, properties).map((c) => ({
    label: c.label,
    kind: kinds[c.kind],
    insertText: c.insertText,
    detail: c.detail,
    sortText: c.sortText,
    range,
  }));
}

const unquote = (name: string) => (name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name.toLowerCase());

/** Tables named after FROM / JOIN / UPDATE / INTO, with their aliases. */
function referencedTables(text: string): { schema: string | null; table: string; alias: string | null }[] {
  const re = /\b(?:from|join|update|into)\s+((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)(?:\s+(?:as\s+)?("[^"]+"|[a-zA-Z_][\w$]*))?/gi;
  const reserved = new Set(["where", "join", "on", "left", "right", "inner", "outer", "full", "cross", "group", "order", "limit", "set", "values", "using", "natural", "lateral", "select", "returning", "as"]);
  const out: { schema: string | null; table: string; alias: string | null }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const parts = m[1].split(/\s*\.\s*/);
    const table = unquote(parts[parts.length - 1]);
    const schema = parts.length > 1 ? unquote(parts[0]) : null;
    const alias = m[2] && !reserved.has(m[2].toLowerCase()) ? unquote(m[2]) : null;
    out.push({ schema, table, alias });
  }
  return out;
}

/** A table named as written in a statement (maybe schema-qualified), found in what the explorer listed. */
function tableOf(ctx: SqlContext, written: string): { schema: string; table: string } | null {
  const parts = written.split(".").map((p) => unquote(p));
  const table = parts[parts.length - 1];
  const schema = findSchema(ctx, table, parts.length > 1 ? parts[0] : null);
  return schema ? { schema, table } : null;
}

/** Every relation of a schema the completion lists offer, continuous aggregates included. */
function relationsOf(o: SchemaObjects): RelationEntry[] {
  return [...o.tables, ...o.views, ...o.materializedViews, ...(o.continuousAggregates ?? [])];
}

function isCagg(o: SchemaObjects, t: RelationEntry): boolean {
  return (o.continuousAggregates ?? []).includes(t);
}

/** What a relation is, as the completion list names it. */
function relationKind(o: SchemaObjects, t: RelationEntry): string {
  if (isCagg(o, t)) return "continuous aggregate";
  if (t.timescale === "hypertable") return "hypertable";
  return t.kind === "v" ? "view" : t.kind === "m" ? "materialized view" : "table";
}

function findSchema(ctx: SqlContext, table: string, schema: string | null): string | null {
  if (schema) return schema;
  const all = objectsOf(ctx);
  const has = (o: SchemaObjects) => relationsOf(o).some((t) => t.name === table);
  return (all.find((s) => s.schema === "public" && has(s.objects)) ?? all.find((s) => has(s.objects)))?.schema ?? null;
}

export function registerSqlCompletion(monaco: typeof Monaco) {
  const { CompletionItemKind: Kind } = monaco.languages;
  for (const language of ["pgsql", "sql", SQL_LANGUAGE]) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: [".", ":", "<"],
      async provideCompletionItems(model, position, completion) {
        const ctx = contexts.get(model.uri.toString())?.() ?? null;
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const text = model.getValue();
        const before = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: word.startColumn,
        });
        const offset = model.getOffsetAt(position);
        const cypher = cypherBodyAt(text, offset);
        if (cypher) {
          const bodyBefore = text.slice(cypher.start, offset);
          return { suggestions: await cypherSuggestions(monaco, ctx, cypher.graph, bodyBefore, completion.triggerCharacter, range) };
        }

        const suggestions: Monaco.languages.CompletionItem[] = [];
        const catalog = ctx ? graphCatalogOf(ctx) : null;

        // pgvector: distance operators after `<`, operator classes after CREATE INDEX ... USING hnsw (col
        const operator = /<[-=#+~%]?$/.exec(before);
        if (operator && catalog?.vector) {
          const opRange = { ...range, startColumn: range.endColumn - operator[0].length };
          return {
            suggestions: VECTOR_OPERATORS.map((o, i) => ({
              label: { label: o.op, description: o.name },
              kind: Kind.Operator,
              insertText: o.op,
              filterText: o.op,
              detail: o.name,
              documentation: o.detail,
              range: opRange,
              sortText: `0${i}`,
            })),
          };
        }
        const index = indexContextAt(text.slice(Math.max(0, offset - 1000), offset));
        if (index && ctx) {
          const owner = index.table ? tableOf(ctx, index.table) : null;
          const column = owner ? (await columnsOf(ctx, owner.schema, owner.table)).find((c) => c.name === unquote(index.column)) : null;
          return {
            suggestions: opclassesFor(index.method, column?.typeName ?? null).map((o, i) => ({
              label: o.name,
              kind: Kind.TypeParameter,
              insertText: o.name,
              detail: o.detail,
              range,
              sortText: String(i).padStart(2, "0"),
            })),
          };
        }
        // a colon or angle bracket typed in plain SQL (a cast, a comparison): nothing to offer
        if (completion.triggerCharacter === ":" || completion.triggerCharacter === "<") return { suggestions: [] };

        const dotted = before.match(/("[^"]+"|[a-zA-Z_][\w$]*)\s*\.\s*$/);

        if (dotted && ctx) {
          const qualifier = unquote(dotted[1]);
          // schema.  -> its relations
          const schema = objectsOf(ctx).find((s) => s.schema === qualifier);
          if (schema) {
            for (const t of relationsOf(schema.objects)) {
              const kind = t.kind === "r" || t.kind === "p" ? Kind.Struct : Kind.Interface;
              suggestions.push({ label: t.name, kind, insertText: quoteIfNeeded(t.name), range, detail: relationKind(schema.objects, t) });
            }
            for (const f of schema.objects.functions) {
              suggestions.push({ label: `${f.name}(${f.args})`, kind: Kind.Function, insertText: `${quoteIfNeeded(f.name)}(`, range, detail: f.returns ?? undefined });
            }
            return { suggestions };
          }
          // alias. or table.  -> its columns
          const refs = referencedTables(text);
          const ref = refs.find((r) => r.alias === qualifier) ?? refs.find((r) => r.table === qualifier) ?? { schema: null, table: qualifier, alias: null };
          const owner = findSchema(ctx, ref.table, ref.schema);
          if (owner) {
            for (const c of await columnsOf(ctx, owner, ref.table)) {
              suggestions.push({ label: c.name, kind: Kind.Field, insertText: quoteIfNeeded(c.name), range, detail: c.typeName, documentation: c.comment ?? undefined });
            }
          }
          return { suggestions };
        }

        if (ctx) {
          // columns of the tables the statement names, first
          const seen = new Set<string>();
          for (const ref of referencedTables(text)) {
            const owner = findSchema(ctx, ref.table, ref.schema);
            if (!owner) continue;
            for (const c of await columnsOf(ctx, owner, ref.table)) {
              if (seen.has(c.name)) continue;
              seen.add(c.name);
              suggestions.push({ label: c.name, kind: Kind.Field, insertText: quoteIfNeeded(c.name), range, detail: `${ref.table} · ${c.typeName}`, sortText: `0${c.name}` });
            }
          }
          for (const { schema, objects } of objectsOf(ctx)) {
            const prefix = schema === "public" ? "" : `${quoteIfNeeded(schema)}.`;
            for (const t of relationsOf(objects)) {
              suggestions.push({
                label: prefix + t.name,
                kind: t.kind === "v" || isCagg(objects, t) ? Kind.Interface : Kind.Struct,
                insertText: prefix + quoteIfNeeded(t.name),
                range,
                detail: `${schema} · ${relationKind(objects, t)}`,
                sortText: `1${t.name}`,
              });
            }
            for (const f of objects.functions) {
              suggestions.push({ label: prefix + f.name, kind: Kind.Function, insertText: `${prefix}${quoteIfNeeded(f.name)}(`, range, detail: `(${f.args})${f.returns ? ` → ${f.returns}` : ""}`, sortText: `3${f.name}` });
            }
          }
          for (const { schema } of objectsOf(ctx)) {
            suggestions.push({ label: schema, kind: Kind.Module, insertText: quoteIfNeeded(schema), range, detail: "schema", sortText: `4${schema}` });
          }
        }
        for (const k of KEYWORDS) suggestions.push({ label: k, kind: Kind.Keyword, insertText: k, range, sortText: `5${k}` });
        if (catalog?.vector) {
          for (const f of VECTOR_FUNCTIONS) {
            suggestions.push({ label: f.name, kind: Kind.Function, insertText: `${f.name}(`, range, detail: f.detail, sortText: `6${f.name}` });
          }
        }
        if (catalog?.timescale) {
          for (const f of TIMESCALE_FUNCTIONS) {
            suggestions.push({ label: f.name, kind: Kind.Function, insertText: `${f.name}(`, range, detail: f.detail, sortText: `6${f.name}` });
          }
        }
        for (const f of FUNCTIONS) suggestions.push({ label: f, kind: Kind.Function, insertText: `${f}(`, range, sortText: `6${f}` });
        return { suggestions };
      },
    });
  }
}

function quoteIfNeeded(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Forgets cached columns, e.g. after DDL. */
export function clearColumnCache() {
  columnCache.clear();
}
