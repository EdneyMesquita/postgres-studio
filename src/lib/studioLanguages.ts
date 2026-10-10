import type * as Monaco from "monaco-editor";
import { conf as pgsqlConf, language as pgsql } from "monaco-editor/languages/definitions/pgsql/pgsql.js";
import { CYPHER_FUNCTIONS, CYPHER_KEYWORDS } from "./cypher";
import { SQL_LANGUAGE } from "./sqlCompletion";

/** Cypher as AGE reads it, the language of a `cypher('graph', $$ ... $$)` body. */
export const CYPHER_LANGUAGE = "age-cypher";

const cypherConf: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
    { open: "`", close: "`", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: "`", close: "`" },
  ],
};

const cypher: Monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".cypher",
  ignoreCase: true,
  keywords: CYPHER_KEYWORDS,
  functions: CYPHER_FUNCTIONS,
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.bracket" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
  ],
  tokenizer: {
    root: [
      [/\/\/.*$/, "comment"],
      [/\/\*/, "comment", "@comment"],
      [/'(?:[^'\\]|\\.)*'/, "string"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/`[^`]*`/, "identifier"],
      [/\$[A-Za-z_]\w*/, "variable"],
      [/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      // (n:Person) and [:KNOWS]: the name after a colon is a label
      [/(:)(\s*)([A-Za-z_]\w*)/, ["delimiter", "white", { cases: { "@keywords": "keyword", "@default": "type" } }]],
      [/[A-Za-z_]\w*(?=\s*\()/, { cases: { "@keywords": "keyword", "@functions": "predefined", "@default": "identifier" } }],
      [/[A-Za-z_]\w*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
      [/[{}()[\]]/, "@brackets"],
      [/[,.;:]/, "delimiter"],
      [/[-+*/%^=<>!|&~]+/, "operator"],
      [/\s+/, "white"],
    ],
    comment: [
      [/[^*/]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[*/]/, "comment"],
    ],
  },
};

/**
 * The PostgreSQL grammar plus one thing: the dollar-quoted body of a
 * `cypher('graph', $$ ... $$)` call is Cypher. The call is followed
 * token by token (the name, the graph literal, the comma) and anything
 * else ends the attempt; once the opening quote is seen, the body is
 * handed to the Cypher grammar until the next dollar quote. Everything
 * else stays the stock grammar, so other dollar-quoted bodies (function
 * definitions) keep being read as SQL and keep their completion. It also
 * knows the keywords of SQL/PGQ.
 */
const sql: Monaco.languages.IMonarchLanguage = {
  ...pgsql,
  keywords: [...(pgsql.keywords as string[]), "graph_table", "match"],
  tokenizer: {
    ...pgsql.tokenizer,
    root: [
      [/\bcypher(?=\s*\()/, { token: "predefined", next: "@cypherCall" }],
      // SQL/PGQ (GRAPH_TABLE, PROPERTY GRAPH), which no PostgreSQL release has shipped yet. COLUMNS
      // and PROPERTY are common names, so they count only where the syntax puts them.
      [/\bproperty\s+graph\b/, "keyword"],
      [/\bcolumns(?=\s*\()/, "keyword"],
      ...pgsql.tokenizer.root,
    ],
    cypherCall: [
      [/\s+/, "white"],
      [/\(/, "@brackets"],
      [/'(?:[^']|'')*'/, "string"],
      [/"(?:[^"]|"")*"/, "identifier"],
      [/,/, "delimiter"],
      [/\$[A-Za-z_]*\$/, { token: "string", switchTo: "@cypherBody", nextEmbedded: CYPHER_LANGUAGE }],
      [/./, { token: "@rematch", next: "@pop" }],
    ],
    cypherBody: [[/\$[A-Za-z_]*\$/, { token: "string", next: "@pop", nextEmbedded: "@pop" }]],
  },
};

/** The console's SQL language, and Cypher for the bodies inside it. */
export function registerStudioLanguages(monaco: typeof Monaco) {
  monaco.languages.register({ id: CYPHER_LANGUAGE, aliases: ["Cypher (Apache AGE)"] });
  monaco.languages.setLanguageConfiguration(CYPHER_LANGUAGE, cypherConf);
  monaco.languages.setMonarchTokensProvider(CYPHER_LANGUAGE, cypher);

  monaco.languages.register({ id: SQL_LANGUAGE, aliases: ["PostgreSQL (Postgres Studio)"] });
  monaco.languages.setLanguageConfiguration(SQL_LANGUAGE, pgsqlConf);
  monaco.languages.setMonarchTokensProvider(SQL_LANGUAGE, sql);
}
