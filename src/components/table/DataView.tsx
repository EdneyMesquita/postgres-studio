import { useEffect, useMemo } from "react";
import { ChevronLeft, ChevronRight, Hash, Plus, Trash2 } from "lucide-react";
import { useConnectionsStore } from "../../store/connectionsStore";
import { hasPendingEdits, useSessionsStore } from "../../store/sessionsStore";
import type { TableTab } from "../../store/sessionsStore";
import { DEFAULT_INSPECTOR_WIDTH, useUiStore } from "../../store/uiStore";
import { formatInt } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ResultGrid } from "../grid/ResultGrid";
import type { GridEditing, KeyTarget } from "../grid/ResultGrid";
import { InspectorResizer } from "../common/InspectorResizer";
import { useElementWidth } from "../common/useElementWidth";
import { useMediaQuery } from "../common/useMediaQuery";
import { PendingBar } from "./PendingBar";
import { RowInspector, keyCondition } from "./RowInspector";
import { TableQueryBar, confirmDiscard } from "./TableQueryBar";

const NARROW_INSPECTOR_WIDTH = 320;
/** Below this width the grid and the inspector stack. */
const STACK_BELOW = 780;

/** A table's rows: the query bar, pending edits, the grid and the row inspector. */
export function DataView({ tab, active, onAsk, flash }: { tab: TableTab; active: boolean; onAsk?: () => void; flash?: boolean }) {
  const session = useConnectionsStore((s) => s.sessions[tab.connection.id]);
  const store = useSessionsStore.getState;

  // Ctrl/Cmd+S commits the pending edits, like the Commit button.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      // A cell still being typed in keeps its value on blur: let it land first.
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
        document.activeElement.blur();
      }
      const current = useSessionsStore.getState().tabs.find((t) => t.id === tab.id);
      const sessionId = useConnectionsStore.getState().sessions[tab.connection.id]?.sessionId;
      if (!current || current.kind !== "table" || !sessionId || current.committing || !hasPendingEdits(current)) return;
      void useSessionsStore.getState().commitEdits(sessionId, tab.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, tab.id, tab.connection.id]);
  const storedWidth = useUiStore((s) => s.inspectorWidth);
  const [box, boxWidth] = useElementWidth<HTMLDivElement>();
  const stacked = useMediaQuery("(max-width: 959px)") || (boxWidth > 0 && boxWidth < STACK_BELOW);
  const narrow = useMediaQuery("(max-width: 1179px)");
  const width = narrow && storedWidth === DEFAULT_INSPECTOR_WIDTH ? NARROW_INSPECTOR_WIDTH : storedWidth;

  const info = tab.info;
  const page = tab.page;
  const columnInfo = useMemo(() => new Map((info?.columns ?? []).map((c) => [c.name, c])), [info]);
  const keyColumns = useMemo(() => new Set(info?.rowKey ?? []), [info]);
  const foreignKeys = useMemo(() => {
    const map = new Map<string, KeyTarget>();
    for (const c of info?.constraints ?? []) {
      // single-column keys link from the cell; composite ones from the inspector
      if (c.kind === "f" && c.columns?.length === 1 && c.refTable && c.refSchema && c.refColumns?.length === 1) {
        map.set(c.columns[0], { schema: c.refSchema, table: c.refTable, column: c.refColumns[0] });
      }
    }
    return map;
  }, [info]);

  const editable = !!info && info.rowKey.length > 0 && (info.kind === "r" || info.kind === "p") && !session?.readOnly;
  const editing: GridEditing | null = editable
    ? {
        edits: tab.edits,
        deleted: tab.deleted,
        inserted: tab.inserted,
        onEdit: (row, column, value) => store().editCell(tab.id, row, column, value),
        onRevert: (row, column) => store().revertCell(tab.id, row, column),
        onEditNew: (index, column, value) => store().editNewRow(tab.id, index, column, value),
        onRemoveNew: (index) => store().removeNewRow(tab.id, index),
        onToggleDeleted: (rows) => store().toggleDeleted(tab.id, rows),
      }
    : null;

  if (!session) return null;

  async function goTo(offset: number) {
    if (!(await confirmDiscard(tab))) return;
    store().updateTab(tab.id, { offset: Math.max(0, offset) });
    await store().runQuery(session!.sessionId, tab.id);
  }

  function follow(target: KeyTarget, value: string) {
    void store().openTable(session!.sessionId, tab.connection, tab.database, target.schema, target.table, "r", {
      where: keyCondition([target.column], [value]),
    });
  }

  const shown = page?.rows.length ?? 0;
  const estimate = info?.rowEstimate ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TableQueryBar tab={tab} onAsk={onAsk} flash={flash} />
      {hasPendingEdits(tab) && <PendingBar tab={tab} />}
      <div className="flex h-[34px] flex-none items-center gap-3 border-b border-line pr-2.5 pl-3 text-sm text-fg-2">
        {tab.exactCount !== null ? (
          <span>
            <span className="font-medium text-fg tabular-nums">{formatInt(tab.exactCount)}</span> rows
          </span>
        ) : !tab.whereText.trim() && estimate !== null ? (
          <span title="The planner's estimate; count for the exact number">
            ~<span className="font-medium text-fg tabular-nums">{formatInt(estimate)}</span> rows
          </span>
        ) : null}
        {page && (
          <span className="tabular-nums max-sm:hidden">
            {shown === 0 ? "no rows" : `showing ${formatInt(tab.offset + 1)}–${formatInt(tab.offset + shown)}`}
          </span>
        )}
        {tab.queryMs !== null && <span className="tabular-nums max-sm:hidden">{tab.loading ? "running…" : `${tab.queryMs} ms`}</span>}
        {tab.loading && tab.queryMs === null && <span>running…</span>}
        <Button
          variant="ghost"
          size="sm"
          disabled={tab.counting}
          onClick={() => void store().countRows(session.sessionId, tab.id)}
          title="Count the rows the filter matches (exact; can take a while on big tables)"
        >
          <Hash />
          {tab.counting ? "Counting…" : "Count"}
        </Button>
        <span className="flex-1" />
        {editable && (
          <>
            <Button variant="ghost" size="sm" onClick={() => store().addRow(tab.id)} title="Add a row (committed with the other changes)">
              <Plus />
              Add row
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={tab.selectedRow === null}
              onClick={() => tab.selectedRow !== null && store().toggleDeleted(tab.id, [tab.selectedRow])}
              title="Mark the selected row for deletion (Del)"
            >
              <Trash2 />
              Delete
            </Button>
          </>
        )}
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-sm disabled:opacity-35"
            aria-label="Previous page"
            title="Previous page"
            disabled={tab.loading || tab.offset === 0}
            onClick={() => void goTo(tab.offset - tab.limit)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-sm disabled:opacity-35"
            aria-label="Next page"
            title="Next page"
            disabled={tab.loading || !page?.hasMore}
            onClick={() => void goTo(tab.offset + tab.limit)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
      {tab.error && (
        <div role="alert" className="flex-none border-b border-line bg-danger/8 px-3 py-2 font-data text-sm whitespace-pre-wrap text-danger">
          {tab.error}
        </div>
      )}
      <div ref={box} className={cn("flex min-h-0 flex-1", stacked && "flex-col")}>
        {page ? (
          <ResultGrid
            columns={page.columns}
            rows={page.rows}
            columnInfo={columnInfo}
            keyColumns={keyColumns}
            foreignKeys={foreignKeys}
            onFollowKey={follow}
            selectedRow={tab.selectedRow}
            onSelectRow={(row) => store().selectRow(tab.id, row)}
            editing={editing}
            rowOffset={tab.offset}
            fadeRight={!stacked}
            aria-label={`Rows of ${tab.schema}.${tab.table}`}
            className={cn("flex-1", tab.loading && "opacity-60")}
          />
        ) : (
          <div className="grid flex-1 place-items-center text-sm text-fg-3">{tab.loading ? "Loading…" : null}</div>
        )}
        {page && (
          <aside
            className={cn("relative flex shrink-0 flex-col", stacked ? "h-[45%] border-t border-line" : "border-l border-line")}
            style={stacked ? undefined : { width }}
          >
            {!stacked && <InspectorResizer width={width} />}
            <RowInspector tab={tab} editable={editable} />
          </aside>
        )}
      </div>
    </div>
  );
}
