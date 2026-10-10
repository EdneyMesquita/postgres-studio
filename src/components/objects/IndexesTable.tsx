import { RefreshCw, Trash2 } from "lucide-react";
import type { IndexInfo } from "../../types/pg";
import type { TableTab } from "../../store/sessionsStore";
import { ActionMenuButton } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { formatBytes, formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dropIndexSql, reindexIndexSql } from "@/lib/objectsSql";
import { openSql } from "./openSql";

const th = "sticky top-[34px] z-[2] h-[30px] bg-panel px-3.5 text-left text-sm font-medium whitespace-nowrap text-fg-2 border-b border-line";
const td = "h-[30px] border-b border-line-soft px-3.5 align-middle";

function Flag({ children, title, className }: { children: string; title?: string; className?: string }) {
  return (
    <span title={title} className={cn("ml-2 font-sans text-xs text-fg-3", className)}>
      {children}
    </span>
  );
}

/** The table's indexes: definition, size, usage and flags, with row actions that open the SQL in a console. */
export function IndexesTable({ tab, indexes }: { tab: TableTab; indexes: IndexInfo[] }) {
  const maxScans = Math.max(1, ...indexes.map((i) => i.scans ?? 0));
  const open = (sql: string) => openSql(tab.connection, tab.database, sql);

  function entries(i: IndexInfo): MenuEntry[] {
    return [
      { heading: i.name },
      { label: "Reindex", icon: RefreshCw, onSelect: () => open(reindexIndexSql(tab.schema, i.name)) },
      {
        label: i.constraint ? "Drop its constraint" : "Drop index",
        icon: Trash2,
        danger: true,
        onSelect: () => open(dropIndexSql(tab.schema, tab.table, i)),
      },
    ];
  }

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={th}>Name</th>
          <th className={th}>Method</th>
          <th className={th}>Columns</th>
          <th className={cn(th, "text-right")}>Size</th>
          <th className={th}>Scans</th>
          <th className={cn(th, "w-9")} />
        </tr>
      </thead>
      <tbody>
        {indexes.map((i) => (
          <tr key={i.name} className="hover:bg-row-hover" title={i.definition}>
            <td className={cn(td, "font-data whitespace-nowrap")}>
              {i.name}
              {i.primary ? <Flag className="text-json-keyword">primary</Flag> : i.unique ? <Flag>unique</Flag> : null}
              {i.partial && <Flag title={i.predicate ? `WHERE ${i.predicate}` : undefined}>partial</Flag>}
              {i.expression && <Flag>expression</Flag>}
              {!i.valid && (
                <Flag className="text-danger" title="A failed CREATE INDEX CONCURRENTLY left it invalid: the planner ignores it. Drop it and build it again.">
                  invalid
                </Flag>
              )}
            </td>
            <td className={cn(td, "font-data text-fg-2")}>{i.method}</td>
            <td className={td}>
              {i.columns.map((c) => (
                <span key={c} className="mr-1 rounded-sm bg-fg/7 px-1.5 py-0.5 font-mono text-sm">
                  {c}
                </span>
              ))}
              {i.include.length > 0 && (
                <>
                  <span className="mr-1 text-xs text-fg-3">include</span>
                  {i.include.map((c) => (
                    <span key={c} className="mr-1 rounded-sm bg-fg/4 px-1.5 py-0.5 font-mono text-sm text-fg-2">
                      {c}
                    </span>
                  ))}
                </>
              )}
              {i.predicate && <span className="font-data text-xs text-fg-3">where {i.predicate}</span>}
            </td>
            <td className={cn(td, "text-right tabular-nums")}>{i.sizeBytes !== null ? formatBytes(i.sizeBytes) : ""}</td>
            <td className={cn(td, "tabular-nums whitespace-nowrap")}>
              <span className="mr-2 inline-block h-1 w-16 overflow-hidden rounded-sm bg-line align-middle">
                <i className="block h-full bg-accent" style={{ width: `${((i.scans ?? 0) / maxScans) * 100}%` }} />
              </span>
              {formatInt(i.scans ?? 0)}
              {(i.scans ?? 0) === 0 && !i.primary && <span className="ml-2 text-xs text-warn">unused</span>}
            </td>
            <td className={cn(td, "text-right")}>
              <ActionMenuButton entries={() => entries(i)} label={`Actions for index ${i.name}`} align="end" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
