import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowLeft, ArrowUpRight, ChevronRight, Copy, KeyRound, Link2 } from "lucide-react";
import { api } from "../../lib/tauri";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { TableTab } from "../../store/sessionsStore";
import { displayValue, kindClass, normalizeBool, prettyJson, valueKind } from "../../lib/pgValue";
import { ident } from "../../lib/editSql";
import { prettyAgtype } from "../../lib/agtype";
import { VectorValue } from "./VectorValue";
import type { BrowseResult, IncomingKey, Row } from "../../types/pg";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A WHERE condition matching these columns to these values. */
export function keyCondition(columns: string[], values: (string | null)[]): string {
  return columns
    .map((c, i) => (values[i] === null ? `${ident(c)} IS NULL` : `${ident(c)} = '${values[i]!.replace(/'/g, "''")}'`))
    .join(" AND ");
}

function SectionHead({ children, count }: { children: string; count?: number }) {
  return (
    <div className="flex h-[30px] items-center gap-1.5 border-t border-line-soft px-3 font-sans text-xs font-semibold text-fg-2 first:border-t-0">
      {children}
      {count !== undefined && <span className="font-normal text-fg-3">{count}</span>}
    </div>
  );
}

/** Opens `table` filtered to `where`, in its own tab. */
function openFiltered(tab: TableTab, schema: string, table: string, where: string) {
  const sessionId = useConnectionsStore.getState().sessions[tab.connection.id]?.sessionId;
  if (!sessionId) return;
  void useSessionsStore.getState().openTable(sessionId, tab.connection, tab.database, schema, table, "r", { where });
}

/**
 * The selected row: its columns as a list (JSON pretty-printed), the rows
 * it references and the rows that reference it. Values edit in place,
 * like the grid's.
 */
/** `editable`: the grid's verdict (a key, a table, a writable connection). */
export function RowInspector({ tab, editable }: { tab: TableTab; editable: boolean }) {
  const editCell = useSessionsStore((s) => s.editCell);
  const readOnlyConnection = useConnectionsStore((s) => s.sessions[tab.connection.id]?.readOnly ?? false);
  const page = tab.page;
  const info = tab.info;
  const row = tab.selectedRow !== null ? page?.rows[tab.selectedRow] : undefined;
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => setEditing(null), [tab.selectedRow]);

  if (!page || !row || tab.selectedRow === null) {
    return <div className="grid h-full place-items-center p-6 text-center text-sm text-fg-3">Select a row to see all of its columns and the rows it relates to.</div>;
  }
  const rowIndex = tab.selectedRow;
  const edits = tab.edits[rowIndex] ?? {};
  const canEdit = editable && !tab.deleted.includes(rowIndex);
  const columnInfo = new Map((info?.columns ?? []).map((c) => [c.name, c]));
  const keyValues = (info?.rowKey ?? []).map((k) => row[page.columns.findIndex((c) => c.name === k)] ?? null);
  const foreignKeys = (info?.constraints ?? []).filter((c) => c.kind === "f" && c.columns && c.refTable);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 flex-none items-center gap-1.5 border-b border-line-soft pr-1.5 pl-3">
        <span className="font-semibold">Row</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-3">
          {info?.rowKey.length ? `${tab.table}.${info.rowKey.map((k, i) => `${k} = ${keyValues[i] ?? "NULL"}`).join(", ")}` : `${tab.table} · row ${tab.offset + rowIndex + 1}`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          title="Copy as JSON"
          aria-label="Copy as JSON"
          onClick={() => void navigator.clipboard.writeText(JSON.stringify(Object.fromEntries(page.columns.map((c, i) => [c.name, row[i]])), null, 2))}
        >
          <Copy />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-4">
        <SectionHead count={page.columns.length}>Columns</SectionHead>
        {page.columns.map((c, i) => {
          const ci = columnInfo.get(c.name);
          const kind = valueKind(c, ci);
          const changed = c.name in edits;
          const value = changed ? edits[c.name] : row[i];
          const isKey = info?.rowKey.includes(c.name);
          const isFk = foreignKeys.some((f) => f.columns!.includes(c.name));
          return (
            <div key={c.name} className="group grid grid-cols-[16px_minmax(0,auto)_1fr_auto] items-start gap-x-1 px-2.5 py-0.5 font-data hover:bg-row-hover">
              <span className="mt-1 grid place-items-center text-fg-3">
                {isKey ? <KeyRound className="size-3 text-json-keyword" /> : isFk ? <Link2 className="size-3 text-accent-text" /> : null}
              </span>
              <span className="whitespace-nowrap text-json-key after:mr-1.5 after:text-json-punct after:content-[':']">{c.name}</span>
              {editing === c.name ? (
                <InspectorEditor
                  initial={value === null ? "" : displayValue(kind, value)}
                  multiline={kind === "json" || kind === "agtype" || (value?.includes("\n") ?? false)}
                  onDone={(next) => {
                    setEditing(null);
                    if (next === undefined) return;
                    editCell(tab.id, rowIndex, c.name, kind === "bool" && next !== null ? (normalizeBool(next) ?? next) : next);
                  }}
                />
              ) : (
                <span
                  className={cn(
                    "min-w-0 rounded-[3px] px-[3px] -ml-[3px] break-words whitespace-pre-wrap",
                    canEdit && "cursor-text group-hover:shadow-[inset_0_0_0_1px_var(--color-line)]",
                    changed && "bg-warn/16 shadow-[inset_2px_0_0_var(--color-warn)]",
                  )}
                  title={changed ? `Was: ${row[i] ?? "NULL"}` : canEdit ? "Double-click to edit" : undefined}
                  onDoubleClick={canEdit ? () => setEditing(c.name) : undefined}
                >
                  {value === null ? (
                    <span className="text-fg-3 italic">NULL</span>
                  ) : kind === "json" ? (
                    <span className="text-fg-2">{prettyJson(value)}</span>
                  ) : kind === "agtype" ? (
                    <span className="text-fg-2">{prettyAgtype(value)}</span>
                  ) : kind === "vector" ? (
                    <VectorValue typeName={c.typeName} value={value} />
                  ) : (
                    <span className={kind === "text" ? "text-json-string" : kindClass(kind)}>{displayValue(kind, value)}</span>
                  )}
                </span>
              )}
              <span className="pl-2 font-sans text-[10px] whitespace-nowrap text-fg-3" title={ci?.comment ?? undefined}>
                {c.typeName}
              </span>
            </div>
          );
        })}

        {info && foreignKeys.length > 0 && (
          <>
            <SectionHead count={foreignKeys.length}>References</SectionHead>
            {foreignKeys.map((fk) => {
              const values = fk.columns!.map((col) => {
                const i = page.columns.findIndex((c) => c.name === col);
                return col in edits ? edits[col] : (row[i] ?? null);
              });
              return (
                <Reference
                  key={fk.name}
                  tab={tab}
                  columns={fk.columns!}
                  values={values}
                  refSchema={fk.refSchema!}
                  refTable={fk.refTable!}
                  refColumns={fk.refColumns ?? []}
                />
              );
            })}
          </>
        )}

        {info && info.referencedBy.length > 0 && info.rowKey.length > 0 && (
          <>
            <SectionHead count={info.referencedBy.length}>Referenced by</SectionHead>
            {info.referencedBy.map((incoming) => {
              const values = incoming.refColumns.map((col) => row[page.columns.findIndex((c) => c.name === col)] ?? null);
              return <Incoming key={`${incoming.schema}.${incoming.table}.${incoming.name}`} tab={tab} incoming={incoming} values={values} />;
            })}
          </>
        )}
      </div>
      <div className="flex flex-none flex-wrap gap-3 border-t border-line-soft px-3 py-[7px] text-xs text-fg-3">
        {canEdit ? (
          <>
            <span>Double-click a value to edit</span>
            <span>edits wait for Commit</span>
          </>
        ) : (
          <span>
            {readOnlyConnection
              ? "Read-only connection"
              : info && info.rowKey.length === 0
                ? "Read-only: no primary or unique key to find this row by"
                : "Read-only"}
          </span>
        )}
      </div>
    </div>
  );
}

/** A referenced row, looked up and summarized: its first few columns. */
function Reference({
  tab,
  columns,
  values,
  refSchema,
  refTable,
  refColumns,
}: {
  tab: TableTab;
  columns: string[];
  values: (string | null)[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
}) {
  const sessionId = useConnectionsStore((s) => s.sessions[tab.connection.id]?.sessionId);
  const [found, setFound] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const where = keyCondition(refColumns, values);
  const allNull = values.every((v) => v === null);

  useEffect(() => {
    if (!sessionId || allNull) return;
    let live = true;
    setFound(null);
    setError(null);
    api
      .browseTable(sessionId, tab.database, refSchema, refTable, { whereClause: where, orderBy: null, limit: 1, offset: 0 })
      .then((r) => live && setFound(r))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [sessionId, tab.database, refSchema, refTable, where, allNull]);

  const target = found?.rows[0];
  const shown = found ? summaryColumns(found, refColumns) : [];
  return (
    <div className="mx-2.5 my-1 overflow-hidden rounded-md border border-line-soft">
      <button
        type="button"
        disabled={allNull}
        className="flex h-[30px] w-full items-center gap-1.5 px-2 text-left text-sm text-fg-2 hover:bg-row-hover disabled:cursor-default"
        onClick={() => openFiltered(tab, refSchema, refTable, where)}
        title={allNull ? undefined : `Open ${refSchema}.${refTable} where ${where}`}
      >
        <Link2 className="size-3.5 shrink-0 text-accent-text" />
        <span className="font-mono text-fg">{columns.join(", ")}</span>
        <span className="text-fg-3">→</span>
        <span className="truncate font-mono text-fg">{refTable}</span>
        <span className="flex-1" />
        {!allNull && <ArrowUpRight className="size-3.5 shrink-0 text-fg-3" />}
      </button>
      <div className="border-t border-line-soft py-1 font-data text-[12px]">
        {allNull ? (
          <p className="px-2.5 text-fg-3 italic">NULL: references nothing</p>
        ) : error ? (
          <p className="px-2.5 text-danger">{error}</p>
        ) : !found ? (
          <p className="px-2.5 text-fg-3">Loading…</p>
        ) : !target ? (
          <p className="px-2.5 text-warn">No matching row</p>
        ) : (
          shown.map(([name, i]) => (
            <div key={name} className="grid grid-cols-[96px_1fr] gap-2 px-2.5 leading-5">
              <span className="truncate text-json-key">{name}</span>
              <span className="truncate text-json-string">{target[i] ?? <span className="text-fg-3 italic">NULL</span>}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Up to three columns that say what a row is: names, emails, codes first. */
function summaryColumns(result: BrowseResult, skip: string[]): [string, number][] {
  const ranked = result.columns
    .map((c, i) => [c.name, i] as [string, number])
    .filter(([name]) => !skip.includes(name))
    .sort(([a], [b]) => score(b) - score(a));
  return ranked.slice(0, 3);
}

function score(name: string): number {
  if (/^(name|title|label|email|username|number|code|sku|slug)$/.test(name)) return 3;
  if (/(name|title|email|code)/.test(name)) return 2;
  if (/(_id|^id)$/.test(name)) return 0;
  return 1;
}

/** Rows elsewhere that point at this one: counted on open, the first few shown. */
function Incoming({ tab, incoming, values }: { tab: TableTab; incoming: IncomingKey; values: (string | null)[] }) {
  const sessionId = useConnectionsStore((s) => s.sessions[tab.connection.id]?.sessionId);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const where = keyCondition(incoming.columns, values);

  useEffect(() => {
    if (!open || !sessionId) return;
    let live = true;
    setRows(null);
    setError(null);
    api
      .browseTable(sessionId, tab.database, incoming.schema, incoming.table, { whereClause: where, orderBy: null, limit: 5, offset: 0 })
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [open, sessionId, tab.database, incoming.schema, incoming.table, where]);

  const shown = rows ? summaryColumns(rows, incoming.columns) : [];
  return (
    <div className="mx-2.5 my-1 overflow-hidden rounded-md border border-line-soft">
      <button
        type="button"
        aria-expanded={open}
        className="flex h-[30px] w-full items-center gap-1.5 px-2 text-left text-sm text-fg-2 hover:bg-row-hover"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-fg-3 transition-transform", open && "rotate-90")} />
        <ArrowLeft className="size-3.5 shrink-0 text-fg-3" />
        <span className="truncate font-mono text-fg">{incoming.schema === tab.schema ? incoming.table : `${incoming.schema}.${incoming.table}`}</span>
        <span className="truncate font-mono text-fg-3">.{incoming.columns.join(", ")}</span>
      </button>
      {open && (
        <div className="border-t border-line-soft py-1 font-data text-[12px]">
          {error ? (
            <p className="px-2.5 text-danger">{error}</p>
          ) : !rows ? (
            <p className="px-2.5 text-fg-3">Loading…</p>
          ) : rows.rows.length === 0 ? (
            <p className="px-2.5 text-fg-3">No rows</p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {shown.map(([name]) => (
                    <th key={name} className="px-2.5 py-0.5 text-left font-sans text-xs font-medium text-fg-3">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.rows.map((r: Row, ri) => (
                  <tr key={ri} className="border-t border-line-soft">
                    {shown.map(([name, i]) => (
                      <td key={name} className="max-w-[140px] truncate px-2.5 py-0.5">
                        {r[i] ?? <span className="text-fg-3 italic">NULL</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button
            type="button"
            className="block px-2.5 pt-1 font-sans text-xs text-accent-text hover:underline"
            onClick={() => openFiltered(tab, incoming.schema, incoming.table, where)}
          >
            Open {rows?.hasMore ? "all" : "them"} in {incoming.table}
          </button>
        </div>
      )}
    </div>
  );
}

function InspectorEditor({
  initial,
  multiline,
  onDone,
}: {
  initial: string;
  multiline: boolean;
  onDone: (value: string | null | undefined) => void;
}) {
  const [text, setText] = useState(initial);
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") onDone(undefined);
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.shiftKey) onDone(null);
    else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onDone(text);
    }
  };
  const common = {
    autoFocus: true,
    spellCheck: false,
    value: text,
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onKeyDown: keys,
    onBlur: () => onDone(text === initial ? undefined : text),
    className: "w-full rounded-[3px] bg-field px-1 font-data text-fg outline-none shadow-[0_0_0_2px_var(--color-accent)]",
    title: multiline ? "Ctrl+Enter keeps, Escape cancels, Ctrl+Shift+Enter sets NULL" : "Enter keeps, Escape cancels, Ctrl+Shift+Enter sets NULL",
  };
  return multiline ? <textarea rows={Math.min(12, text.split("\n").length + 1)} {...common} /> : <input {...common} />;
}
