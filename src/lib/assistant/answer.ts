/**
 * Reading an agent's answer: prose, and the fenced blocks it proposes. The
 * system prompt asks for ```where <schema.table> and ```sql; anything else
 * fenced is shown as plain code.
 */

export type ProposalKind = "filter" | "script";

export interface Proposal {
  /** filter: a WHERE condition for a table; script: SQL for a console. */
  kind: ProposalKind;
  /** The table named after the language (schema.table), if any. */
  table: string | null;
  code: string;
}

export type AnswerBlock =
  | { kind: "prose"; text: string }
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "code"; lang: string; code: string; open: boolean };

const KINDS: Record<string, ProposalKind> = {
  where: "filter",
  filter: "filter",
  sql: "script",
  pgsql: "script",
  postgres: "script",
  postgresql: "script",
  psql: "script",
};

/**
 * Splits `text` into prose and fenced blocks. A fence still open (the answer
 * is streaming) comes back as plain code, so no card acts on half a query.
 */
export function parseAnswer(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  const lines = text.split("\n");
  let prose: string[] = [];
  let fence: { lang: string; info: string; body: string[] } | null = null;

  const flushProse = () => {
    const joined = prose.join("\n").trim();
    if (joined) blocks.push({ kind: "prose", text: joined });
    prose = [];
  };

  for (const line of lines) {
    const marker = /^\s*```\s*([\w-]*)\s*(.*)$/.exec(line);
    if (fence) {
      if (marker && !marker[1] && !marker[2]) {
        blocks.push(closeFence(fence.lang, fence.info, fence.body.join("\n")));
        fence = null;
      } else fence.body.push(line);
    } else if (marker) {
      flushProse();
      fence = { lang: marker[1].toLowerCase(), info: marker[2].trim(), body: [] };
    } else prose.push(line);
  }
  flushProse();
  if (fence) blocks.push({ kind: "code", lang: fence.lang, code: fence.body.join("\n"), open: true });
  return blocks;
}

function closeFence(lang: string, info: string, code: string): AnswerBlock {
  const kind = KINDS[lang];
  if (!kind) return { kind: "code", lang, code, open: false };
  const table = kind === "script" ? null : /^[\w."$-]+$/.test(info) ? info.replace(/"/g, "") : null;
  return { kind: "proposal", proposal: { kind, table, code: kind === "filter" ? code.trim().replace(/;$/, "") : code.trim() } };
}

/** The first proposal of a kind in an answer, for the inline asks. */
export function firstProposal(text: string, kind: ProposalKind): Proposal | null {
  for (const block of parseAnswer(text)) {
    if (block.kind === "proposal" && block.proposal.kind === kind) return block.proposal;
  }
  return null;
}

/** Statement keywords that change data or schema. */
const WRITES = /^\s*(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|reindex|cluster|refresh|comment|call|do)\b/i;

export interface ScriptWrite {
  /** The statement's keyword, upper-cased. */
  command: string;
  /** The table it names, when plain to see. */
  table: string | null;
}

/**
 * The statements of proposed SQL that write, found by their keyword (and
 * data-modifying CTEs). A heuristic for the warning on the card: the SQL
 * itself only runs when the user presses Run.
 */
export function scriptWrites(code: string): ScriptWrite[] {
  const stripped = code.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/'(?:[^']|'')*'/g, "''");
  const writes: ScriptWrite[] = [];
  for (const stmt of stripped.split(";")) {
    const m = WRITES.exec(stmt);
    if (m) {
      const target = /\b(?:into|update|from|table|on)\s+("?[\w.$"]+"?)/i.exec(stmt);
      writes.push({ command: m[1].toUpperCase(), table: target ? target[1].replace(/"/g, "") : null });
    } else if (/^\s*with\b[\s\S]*\b(insert|update|delete)\b/i.test(stmt)) {
      writes.push({ command: "WITH", table: null });
    }
  }
  return writes;
}
