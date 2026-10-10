/**
 * How the quick-open palette matches what's typed: every typed word must
 * appear somewhere in an item's keywords (its label first, then where it
 * lives), and a hit in the label ranks higher.
 */

/** Ranks: the label starts with the query, contains it, or only the words match. */
const STARTS = 1;
const CONTAINS = 0.8;
const WORDS = 0.5;

/**
 * The score of one item, 0 when it doesn't match. `query` is trimmed and
 * lowercased; `label` and `haystack` (every keyword, space-joined) are
 * lowercased.
 */
export function matchScore(query: string, label: string, haystack: string): number {
  if (!query) return 1;
  for (const word of query.split(/\s+/)) {
    if (!haystack.includes(word)) return 0;
  }
  if (label.startsWith(query)) return STARTS;
  if (label.includes(query)) return CONTAINS;
  return WORDS;
}

/** cmdk's `filter`, for items whose keywords are [label, ...where]. */
export function matchKeywords(_value: string, search: string, keywords: string[] = []): number {
  const [label = "", ...rest] = keywords.map((k) => k.toLowerCase());
  return matchScore(search.trim().toLowerCase(), label, [label, ...rest].join(" "));
}

export interface Searchable {
  /** Lowercased. */
  label: string;
  /** Every keyword, lowercased and space-joined. */
  haystack: string;
}

/**
 * The best `limit` items for the query, best first and in list order within
 * a rank, and how many match in all. An empty query matches everything.
 * One pass over the list: it stays fast with tens of thousands of items,
 * where rendering them all (and letting cmdk sort the DOM) does not.
 */
export function topMatches<T extends Searchable>(
  items: readonly T[],
  search: string,
  limit: number,
): { items: T[]; total: number } {
  const query = search.trim().toLowerCase();
  if (!query) return { items: items.slice(0, limit), total: items.length };
  const starts: T[] = [];
  const contains: T[] = [];
  const words: T[] = [];
  let total = 0;
  for (const item of items) {
    const score = matchScore(query, item.label, item.haystack);
    if (score === 0) continue;
    total++;
    // no rank needs more than `limit`; the rest only add to the count
    const bucket = score === STARTS ? starts : score === CONTAINS ? contains : words;
    if (bucket.length < limit) bucket.push(item);
  }
  return { items: [...starts, ...contains, ...words].slice(0, limit), total };
}
