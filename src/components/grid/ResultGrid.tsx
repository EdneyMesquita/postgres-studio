import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { ArrowUpRight, KeyRound, Link2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { RowContextMenu } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { alignsRight, cellParts, cellText, displayValue, jsonValue, kindClass, normalizeBool, valueKind } from "../../lib/pgValue";
import type { ValueKind } from "../../lib/pgValue";
import type { ColumnInfo, ResultColumn, Row } from "../../types/pg";
import type { NewRow } from "../../store/sessionsStore";
import { useScrollbarWidth } from "./useScrollbarWidth";
import { useVirtualRows } from "./useVirtualRows";

const HEADER_HEIGHT = 30;

/** Where a foreign key column points. */
export interface KeyTarget {
  schema: string;
  table: string;
  column: string;
}

export interface GridEditing {
  /** Changed values by row, then column. */
  edits: Record<number, Record<string, string | null>>;
  deleted: number[];
  inserted: NewRow[];
  onEdit: (row: number, column: string, value: string | null) => void;
  onRevert: (row: number, column: string) => void;
  onEditNew: (index: number, column: string, value: string | null | undefined) => void;
  onRemoveNew: (index: number) => void;
  onToggleDeleted: (rows: number[]) => void;
}

interface ResultGridProps {
  columns: ResultColumn[];
  rows: Row[];
  /** Catalog details per column name, for enums, keys and categories. */
  columnInfo?: Map<string, ColumnInfo>;
  keyColumns?: Set<string>;
  foreignKeys?: Map<string, KeyTarget>;
  onFollowKey?: (target: KeyTarget, value: string) => void;
  selectedRow?: number | null;
  onSelectRow?: (row: number) => void;
  /** Present when rows can be changed. */
  editing?: GridEditing | null;
  /** Row numbers start after this (the page's offset). */
  rowOffset?: number;
  fadeRight?: boolean;
  "aria-label": string;
  className?: string;
}

interface CellRef {
  row: number;
  column: string;
  /** In the rows being added. */
  isNew: boolean;
}

/** Copies text; says so when asked, and when it fails. */
function copy(text: string, done?: string) {
  navigator.clipboard.writeText(text).then(
    () => done && toast.success(done),
    (e) => toast.error("Couldn't copy", { description: String(e) }),
  );
}

/**
 * Rows as a grid: a sticky header with each column's type and key marks,
 * sticky row numbers, values colored by type, NULL set apart. With
 * `editing`, a double-click edits a cell in place; changed cells, rows to
 * delete and rows to add stay marked until committed. Large results render
 * only the rows in view.
 */
export function ResultGrid({
  columns,
  rows,
  columnInfo,
  keyColumns,
  foreignKeys,
  onFollowKey,
  selectedRow = null,
  onSelectRow,
  editing = null,
  rowOffset = 0,
  fadeRight = false,
  className,
  ...aria
}: ResultGridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const scrollbar = useScrollbarWidth(scroller);
  const inserted = editing?.inserted ?? [];
  const total = rows.length + inserted.length;
  const virtual = useVirtualRows(scroller, total, HEADER_HEIGHT);
  const [active, setActive] = useState<CellRef | null>(null);
  const menuCell = useRef<CellRef | null>(null);
  const kinds = useMemo(
    () => columns.map((c) => valueKind(c, columnInfo?.get(c.name) ?? null)),
    [columns, columnInfo],
  );
  const deleted = useMemo(() => new Set(editing?.deleted ?? []), [editing?.deleted]);

  // a new page or result closes any open editor
  useEffect(() => setActive(null), [rows]);

  const select = useCallback(
    (row: number) => {
      onSelectRow?.(row);
      virtual.reveal(row);
    },
    [onSelectRow, virtual],
  );

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget || !onSelectRow || rows.length === 0) return;
    const last = rows.length - 1;
    const current = selectedRow ?? -1;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(last, current + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Delete" && editing && selectedRow !== null) {
      e.preventDefault();
      editing.onToggleDeleted([selectedRow]);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    select(next);
  }

  function cellFromEvent(e: MouseEvent): CellRef | null {
    const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-col]");
    if (!td) return null;
    return { row: Number(td.dataset.row), column: td.dataset.col!, isNew: td.dataset.new === "1" };
  }

  function valueAt(cell: CellRef): string | null | undefined {
    if (cell.isNew) return inserted[cell.row]?.[cell.column];
    const changed = editing?.edits[cell.row];
    if (changed && cell.column in changed) return changed[cell.column];
    const i = columns.findIndex((c) => c.name === cell.column);
    return rows[cell.row]?.[i] ?? null;
  }

  function menuEntries(): MenuEntry[] {
    const cell = menuCell.current;
    if (!cell) return [];
    const value = valueAt(cell);
    const entries: MenuEntry[] = [];
    const fk = foreignKeys?.get(cell.column);
    if (fk && typeof value === "string" && onFollowKey && !cell.isNew) {
      entries.push({ label: `Go to ${fk.table} where ${fk.column} = ${value}`, icon: ArrowUpRight, onSelect: () => onFollowKey(fk, value) });
    }
    entries.push({ label: "Copy value", onSelect: () => copy(value ?? "") });
    entries.push({
      label: "Copy row as JSON",
      onSelect: () => {
        const source = cell.isNew ? null : rows[cell.row];
        const object = Object.fromEntries(
          columns.map((c, i) => [c.name, jsonValue(c, source ? source[i] : (inserted[cell.row]?.[c.name] ?? null))]),
        );
        copy(JSON.stringify(object, null, 2), "Copied the row as JSON");
      },
    });
    if (editing) {
      entries.push({ separator: true });
      entries.push({ label: "Edit", shortcut: "Double-click", onSelect: () => setActive(cell) });
      entries.push({
        label: "Set NULL",
        onSelect: () => (cell.isNew ? editing.onEditNew(cell.row, cell.column, null) : editing.onEdit(cell.row, cell.column, null)),
      });
      if (cell.isNew) {
        entries.push({ label: "Use DEFAULT", onSelect: () => editing.onEditNew(cell.row, cell.column, undefined) });
        entries.push({ separator: true }, { label: "Remove new row", danger: true, onSelect: () => editing.onRemoveNew(cell.row) });
      } else {
        if (editing.edits[cell.row] && cell.column in editing.edits[cell.row]) {
          entries.push({ label: "Revert this value", onSelect: () => editing.onRevert(cell.row, cell.column) });
        }
        entries.push({ separator: true });
        entries.push({
          label: deleted.has(cell.row) ? "Keep row" : "Delete row",
          shortcut: "Del",
          danger: !deleted.has(cell.row),
          onSelect: () => editing.onToggleDeleted([cell.row]),
        });
      }
    }
    return entries;
  }

  return (
    <div className={cn("relative flex min-h-0 min-w-0", className)}>
      <RowContextMenu entries={menuEntries}>
        <div
          ref={scroller}
          tabIndex={onSelectRow ? 0 : undefined}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto outline-none"
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            menuCell.current = cellFromEvent(e);
            if (menuCell.current && !menuCell.current.isNew) onSelectRow?.(menuCell.current.row);
          }}
        >
          <table
            role="grid"
            aria-label={aria["aria-label"]}
            aria-rowcount={total + 1}
            className="min-w-full border-separate border-spacing-0 font-data"
          >
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky top-0 left-0 z-[3] h-[30px] w-11 min-w-11 border-r border-b border-r-line-soft border-b-line bg-panel px-2 text-right font-sans text-sm font-medium text-fg-3"
                >
                  #
                </th>
                {columns.map((c, ci) => {
                  const info = columnInfo?.get(c.name);
                  const fk = foreignKeys?.get(c.name);
                  const isKey = keyColumns?.has(c.name);
                  return (
                    <th
                      key={`${c.name}-${ci}`}
                      scope="col"
                      title={`${c.name} ${c.typeName}${info && !info.nullable ? " NOT NULL" : ""}${fk ? ` → ${fk.schema}.${fk.table}(${fk.column})` : ""}${info?.comment ? `\n${info.comment}` : ""}`}
                      className={cn(
                        "sticky top-0 z-[2] h-[30px] max-w-[320px] overflow-hidden border-r border-b border-r-line-soft border-b-line bg-panel px-2.5 font-sans text-sm font-medium text-ellipsis whitespace-nowrap text-fg",
                        alignsRight(kinds[ci]) ? "text-right" : "text-left",
                      )}
                    >
                      {isKey && <KeyRound className="mr-1 inline size-3 align-[-1px] text-json-keyword" aria-label="Key" />}
                      {fk && !isKey && <Link2 className="mr-1 inline size-3 align-[-1px] text-accent-text" aria-label="Foreign key" />}
                      {c.name}
                      <span className="ml-1.5 font-mono text-2xs font-normal text-fg-3">{c.typeName}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {virtual.padTop > 0 && (
                <tr aria-hidden style={{ height: virtual.padTop }}>
                  <td colSpan={columns.length + 1} className="p-0" />
                </tr>
              )}
              {Array.from({ length: virtual.end - virtual.start }, (_, offset) => {
                const i = virtual.start + offset;
                const isNew = i >= rows.length;
                const index = isNew ? i - rows.length : i;
                return (
                  <GridRow
                    key={isNew ? `new-${index}` : i}
                    index={index}
                    position={i}
                    isNew={isNew}
                    row={isNew ? null : rows[index]}
                    newRow={isNew ? inserted[index] : null}
                    rowNumber={isNew ? null : rowOffset + index + 1}
                    columns={columns}
                    kinds={kinds}
                    edits={isNew ? undefined : editing?.edits[index]}
                    deleted={!isNew && deleted.has(index)}
                    selected={!isNew && index === selectedRow}
                    activeColumn={active && active.isNew === isNew && active.row === index ? active.column : null}
                    foreignKeys={foreignKeys}
                    canEdit={editing !== null}
                    onSelect={onSelectRow ? select : undefined}
                    onStartEdit={(column) => editing && setActive({ row: index, column, isNew })}
                    onFinishEdit={(column, value) => {
                      setActive(null);
                      if (!editing || value === undefined) return;
                      if (isNew) editing.onEditNew(index, column, value);
                      else editing.onEdit(index, column, value);
                    }}
                    onFollowKey={onFollowKey}
                  />
                );
              })}
              {virtual.padBottom > 0 && (
                <tr aria-hidden style={{ height: virtual.padBottom }}>
                  <td colSpan={columns.length + 1} className="p-0" />
                </tr>
              )}
            </tbody>
          </table>
          {total === 0 && <p className="px-3 py-3 font-sans text-sm text-fg-3">No rows.</p>}
        </div>
      </RowContextMenu>
      {fadeRight && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-9 bg-linear-to-r from-transparent to-editor"
          style={{ right: scrollbar }}
        />
      )}
    </div>
  );
}

interface GridRowProps {
  index: number;
  /** Position among all rendered rows, for the virtualizer. */
  position: number;
  isNew: boolean;
  row: Row | null;
  newRow: NewRow | null;
  rowNumber: number | null;
  columns: ResultColumn[];
  kinds: ValueKind[];
  edits: Record<string, string | null> | undefined;
  deleted: boolean;
  selected: boolean;
  activeColumn: string | null;
  foreignKeys?: Map<string, KeyTarget>;
  canEdit: boolean;
  onSelect?: (row: number) => void;
  onStartEdit: (column: string) => void;
  /** undefined: cancelled. */
  onFinishEdit: (column: string, value: string | null | undefined) => void;
  onFollowKey?: (target: KeyTarget, value: string) => void;
}

const GridRow = memo(function GridRow({
  index,
  position,
  isNew,
  row,
  newRow,
  rowNumber,
  columns,
  kinds,
  edits,
  deleted,
  selected,
  activeColumn,
  foreignKeys,
  canEdit,
  onSelect,
  onStartEdit,
  onFinishEdit,
  onFollowKey,
}: GridRowProps) {
  const cellBg = selected ? "bg-sel-soft" : isNew ? "bg-ok/8" : deleted ? "bg-danger/8" : "group-hover/row:bg-row-hover";
  return (
    <tr
      data-row={position}
      aria-selected={onSelect && !isNew ? selected : undefined}
      className={cn("group/row scroll-mt-[30px]", onSelect && !isNew && "cursor-pointer")}
      onClick={onSelect && !isNew ? () => onSelect(index) : undefined}
    >
      <td
        className={cn(
          "sticky left-0 z-[1] h-6 w-11 min-w-11 border-r border-b border-line-soft px-2 text-right",
          selected ? "bg-sel-soft text-fg" : isNew ? "bg-editor text-ok" : "bg-editor text-fg-3 group-hover/row:bg-row-hover",
        )}
      >
        {isNew ? "+" : (
          <>
            {(edits || deleted) && (
              <span
                className={cn("mr-1.5 inline-block size-1.5 rounded-full align-[1px]", deleted ? "bg-danger" : "bg-warn")}
                title={deleted ? "Will be deleted" : "Changed, not committed"}
              />
            )}
            {rowNumber}
          </>
        )}
      </td>
      {columns.map((c, ci) => {
        const changed = edits !== undefined && c.name in edits;
        const raw: string | null | undefined = isNew
          ? newRow?.[c.name]
          : changed
            ? edits[c.name]
            : (row?.[ci] ?? null);
        const kind = kinds[ci];
        const fk = foreignKeys?.get(c.name);
        if (activeColumn === c.name) {
          return (
            <td key={`${c.name}-${ci}`} className="h-6 border-r border-b border-line-soft p-0 shadow-[inset_0_0_0_2px_var(--color-accent)]">
              <CellEditor
                initial={raw === undefined || raw === null ? "" : displayValue(kind, raw)}
                onDone={(value) =>
                  // booleans show spelled out; t / f is what's stored
                  onFinishEdit(c.name, kind === "bool" && typeof value === "string" ? (normalizeBool(value) ?? value) : value)
                }
              />
            </td>
          );
        }
        return (
          <td
            key={`${c.name}-${ci}`}
            data-row={index}
            data-col={c.name}
            data-new={isNew ? "1" : undefined}
            title={
              changed
                ? `Was: ${row?.[ci] ?? "NULL"}`
                : typeof raw === "string" && raw.length > 60
                  ? raw.slice(0, 2000)
                  : undefined
            }
            className={cn(
              "h-6 max-w-[320px] overflow-hidden border-r border-b border-line-soft px-2.5 text-ellipsis whitespace-nowrap",
              alignsRight(kind) && "text-right",
              cellBg,
              changed && "bg-warn/14 shadow-[inset_2px_0_0_var(--color-warn)]",
              deleted && "text-fg-3 line-through",
            )}
            onDoubleClick={canEdit && !deleted ? () => onStartEdit(c.name) : undefined}
          >
            {raw === undefined ? (
              <span className="text-fg-3 italic">DEFAULT</span>
            ) : raw === null ? (
              <span className="text-fg-3 italic">NULL</span>
            ) : fk && onFollowKey && !isNew ? (
              <button
                type="button"
                className="group/fk inline-flex items-center gap-1 text-json-number underline decoration-accent-text/60 decoration-dotted underline-offset-3 hover:text-accent-text"
                title={`Go to ${fk.schema}.${fk.table} where ${fk.column} = ${raw}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onFollowKey(fk, raw);
                }}
              >
                {cellText(raw)}
                <ArrowUpRight className="size-3 text-accent-text opacity-0 group-hover/row:opacity-100" aria-hidden />
              </button>
            ) : (
              <CellValue kind={kind} typeName={c.typeName} raw={raw} />
            )}
          </td>
        );
      })}
    </tr>
  );
});

/** A value in its type's color, with the muted tag some types add (a vector's `1536d`). */
function CellValue({ kind, typeName, raw }: { kind: ValueKind; typeName: string; raw: string }) {
  const { text, tag } = cellParts(kind, typeName, raw);
  return (
    <>
      <span className={kindClass(kind)}>{text}</span>
      {tag && <span className="ml-1.5 text-fg-3">{tag}</span>}
    </>
  );
}

/** The in-place editor: Enter keeps, Escape cancels, Ctrl+Enter or the null button sets NULL. */
function CellEditor({ initial, onDone }: { initial: string; onDone: (value: string | null | undefined) => void }) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (value: string | null | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      autoFocus
      spellCheck={false}
      className="h-6 w-full min-w-[120px] border-0 bg-field px-2 font-data text-fg outline-none"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) finish(null);
        else if (e.key === "Enter") finish(text);
        else if (e.key === "Escape") finish(undefined);
      }}
      onBlur={() => finish(text === initial ? undefined : text)}
      title="Enter keeps the value, Escape cancels, Ctrl+Enter sets NULL"
    />
  );
}
