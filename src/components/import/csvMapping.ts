import type { ColumnInfo } from "@/types/pg";

/** The columns a CSV can be loaded into: not generated ones, which refuse values. */
export function loadableColumns(columns: ColumnInfo[]): ColumnInfo[] {
  return columns.filter((c) => c.identity !== "a" && c.generated === null);
}

/**
 * Which table column each file column goes to: by header name first, ignoring
 * case; the file columns left over take the table column at their own
 * position when nothing else uses it. Null skips a file column.
 */
export function autoMap(headers: string[] | null, columns: number, targets: string[]): (string | null)[] {
  const mapping: (string | null)[] = Array.from({ length: columns }, () => null);
  const used = new Set<string>();
  if (headers) {
    const byName = new Map<string, string>();
    for (const t of targets) if (!byName.has(t.toLowerCase())) byName.set(t.toLowerCase(), t);
    headers.forEach((h, i) => {
      const target = byName.get(h.trim().toLowerCase());
      if (i < columns && target && !used.has(target)) {
        mapping[i] = target;
        used.add(target);
      }
    });
  }
  for (let i = 0; i < columns; i++) {
    const target = targets[i];
    if (mapping[i] === null && target !== undefined && !used.has(target)) {
      mapping[i] = target;
      used.add(target);
    }
  }
  return mapping;
}

/** Table columns that more than one file column goes to. */
export function duplicateTargets(mapping: (string | null)[]): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const m of mapping) {
    if (m === null) continue;
    if (seen.has(m)) dupes.add(m);
    seen.add(m);
  }
  return dupes;
}

/** Columns the import leaves unset that the table can't fill itself. */
export function missingRequired(columns: ColumnInfo[], mapping: (string | null)[]): string[] {
  const mapped = new Set(mapping.filter((m): m is string => m !== null));
  return columns
    .filter((c) => !c.nullable && c.default === null && c.identity === null && c.generated === null && !mapped.has(c.name))
    .map((c) => c.name);
}
