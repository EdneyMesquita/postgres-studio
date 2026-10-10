import type { TableTab } from "../store/sessionsStore";

/** "name" quoted only when it needs it. */
export function ident(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string | null | undefined): string {
  if (value === undefined) return "DEFAULT";
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The SQL a commit runs, for reading before committing. The commit itself
 * sends values as parameters cast to each column's type, so this is a
 * faithful picture rather than the exact text.
 */
export function previewEdits(tab: TableTab): string {
  const { page, info } = tab;
  if (!page || !info) return "";
  const target = `${ident(tab.schema)}.${ident(tab.table)}`;
  const keyWhere = (row: number) =>
    info.rowKey
      .map((k) => {
        const i = page.columns.findIndex((c) => c.name === k);
        return `${ident(k)} = ${literal(page.rows[row]?.[i] ?? null)}`;
      })
      .join(" AND ");
  const lines = ["BEGIN;"];
  for (const [rowText, values] of Object.entries(tab.edits)) {
    const row = Number(rowText);
    if (tab.deleted.includes(row)) continue;
    const sets = Object.entries(values)
      .map(([column, value]) => `${ident(column)} = ${literal(value)}`)
      .join(", ");
    lines.push(`UPDATE ${target} SET ${sets} WHERE ${keyWhere(row)};`);
  }
  for (const row of tab.inserted) {
    const given = info.columns.filter((c) => row[c.name] !== undefined);
    lines.push(
      given.length === 0
        ? `INSERT INTO ${target} DEFAULT VALUES;`
        : `INSERT INTO ${target} (${given.map((c) => ident(c.name)).join(", ")}) VALUES (${given.map((c) => literal(row[c.name])).join(", ")});`,
    );
  }
  for (const row of tab.deleted) lines.push(`DELETE FROM ${target} WHERE ${keyWhere(row)};`);
  lines.push("COMMIT;");
  return lines.join("\n");
}
