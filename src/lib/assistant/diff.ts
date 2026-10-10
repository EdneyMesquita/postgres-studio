
/** The changed span of `after` against `before`: common prefix and suffix trimmed. */
export function changedSpan(before: string, after: string): { start: number; end: number } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < max - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { start, end: after.length - tail };
}

/**
 * Lines of `after` that aren't in `before` (by longest common subsequence),
 * as 0-based indexes, and how many lines of `before` are gone.
 */
export function lineDiff(before: string, after: string): { added: number[]; removed: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: common subsequence length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const added: number[] = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else added.push(j++);
  }
  return { added, removed: n - lcs[0][0] };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The top-level AND terms of a condition, normalized for comparing. */
function terms(condition: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const text = condition.trim();
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /\s/.test(c) && /^and\s/i.test(text.slice(i + 1, i + 5))) {
      out.push(text.slice(start, i));
      start = i + 4;
    }
  }
  out.push(text.slice(start));
  return out.map((t) => t.trim().replace(/\s+/g, " ").toLowerCase()).filter(Boolean);
}

/** "2 conditions added", "1 condition removed", or "condition rewritten". */
export function filterChangeSummary(before: string, after: string): string {
  const a = terms(before);
  const b = terms(after);
  const added = b.filter((t) => !a.includes(t)).length;
  const removed = a.filter((t) => !b.includes(t)).length;
  if (!added && !removed) return "no change";
  if (added && removed && a.length === removed) return "condition rewritten";
  const parts: string[] = [];
  if (added) parts.push(`${plural(added, "condition", "conditions")} added`);
  if (removed) parts.push(parts.length ? `${removed} removed` : `${plural(removed, "condition", "conditions")} removed`);
  return parts.join(", ");
}

/** "1 line added", "3 lines added, 1 removed". */
export function scriptChangeSummary(added: number, removed: number): string {
  if (!added && !removed) return "no change";
  if (!added) return `${plural(removed, "line", "lines")} removed`;
  return removed ? `${plural(added, "line", "lines")} added, ${removed} removed` : `${plural(added, "line", "lines")} added`;
}
