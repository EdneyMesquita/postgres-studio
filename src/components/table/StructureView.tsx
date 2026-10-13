import { Copy, FileCode, KeyRound, Link2, Plus, RefreshCw, SquareTerminal, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useConsoleStore } from "../../store/consoleStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { TableTab } from "../../store/sessionsStore";
import { formatBytes, formatInt } from "@/lib/format";
import { refreshMatviewSql } from "@/lib/objectsSql";
import { IndexesTable } from "../objects/IndexesTable";
import { NewIndexDialog } from "../objects/NewIndexDialog";
import { TriggersTable } from "../objects/TriggersSection";
import { openSql } from "../objects/openSql";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SqlText } from "../console/SqlText";
import { Section, td, th } from "./structureParts";
import { TimescaleHeaderExtras, TimescaleHead, TimescaleTail } from "../timescale/TimescaleSections";
import { useTimescaleDetail } from "../timescale/useTimescaleDetail";

const CONSTRAINT_KIND: Record<string, { label: string; className: string }> = {
  p: { label: "PRIMARY KEY", className: "text-json-keyword" },
  u: { label: "UNIQUE", className: "text-fg-2" },
  f: { label: "FOREIGN KEY", className: "text-accent-text" },
  c: { label: "CHECK", className: "text-fg-2" },
  x: { label: "EXCLUDE", className: "text-fg-2" },
  t: { label: "TRIGGER", className: "text-fg-2" },
};

/** Columns, constraints, indexes and triggers, with the DDL beside them. */
export function StructureView({ tab }: { tab: TableTab }) {
  const session = useConnectionsStore((s) => s.sessions[tab.connection.id]);
  const [newIndexOpen, setNewIndexOpen] = useState(false);
  const info = tab.info;
  const ts = useTimescaleDetail(tab);

  if (!info) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-sm text-fg-3">
        {tab.infoError ? <span className="text-danger">{tab.infoError}</span> : "Loading…"}
      </div>
    );
  }

  const fkOf = (column: string) => info.constraints.find((c) => c.kind === "f" && c.columns?.length === 1 && c.columns[0] === column);
  const isView = info.kind === "v" || info.kind === "m";

  function openDdl() {
    if (!session) return;
    const id = useSessionsStore.getState().openConsole(tab.connection, tab.database);
    useConsoleStore.getState().setScript(id, info!.ddl);
  }

  return (
    <div className="@container flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-auto pb-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line-soft px-3.5 py-2 text-sm text-fg-2">
          <span>
            {(info.hypertable && "Hypertable") ||
              (info.cagg && "Continuous aggregate") ||
              (info.chunk && "Chunk") ||
              { r: "Table", p: "Partitioned table", f: "Foreign table", v: "View", m: "Materialized view", S: "Sequence" }[info.kind]}{" "}
            <span className="font-mono text-fg">
              {info.schema}.{info.name}
            </span>
          </span>
          {info.rowEstimate !== null && <span>~{formatInt(info.rowEstimate)} rows</span>}
          {info.sizeBytes !== null && <span>{formatBytes(info.sizeBytes)} on disk</span>}
          <TimescaleHeaderExtras tab={tab} ts={ts} />
          {info.stats?.deadRows ? <span title="Dead rows waiting for vacuum">{formatInt(info.stats.deadRows)} dead rows</span> : null}
          {info.stats?.lastAnalyze && <span>analyzed {info.stats.lastAnalyze.slice(0, 16).replace("T", " ")}</span>}
          {info.comment && <span className="text-fg-3 italic">{info.comment}</span>}
          <span className="flex-1" />
          {!isView && (
            <Button
              variant="ghost"
              size="sm"
              title="The schema diagram, around this table"
              onClick={() => useSessionsStore.getState().openDiagram(tab.connection, tab.database, tab.schema, tab.table)}
            >
              <Workflow />
              Diagram
            </Button>
          )}
          {/* The DDL pane is left out when narrow; this stands in for it. */}
          <Button variant="ghost" size="sm" className="@min-[1081px]:hidden" title="Open the DDL in a SQL console" onClick={openDdl}>
            <FileCode />
            DDL
          </Button>
        </div>

        <TimescaleHead tab={tab} ts={ts} />

        {isView && info.viewDefinition && (
          <Section
            title="Definition"
            action={
              info.kind === "m" && !info.cagg ? (
                <Button
                  variant="ghost"
                  size="sm"
                  title="Open REFRESH MATERIALIZED VIEW in a console"
                  onClick={() => openSql(tab.connection, tab.database, refreshMatviewSql(tab.schema, tab.table, info.indexes))}
                >
                  <RefreshCw />
                  Refresh materialized view
                </Button>
              ) : undefined
            }
          >
            <div className="border-b border-line-soft px-3.5 py-2">
              <SqlText text={info.viewDefinition.trim()} className="whitespace-pre-wrap" />
            </div>
          </Section>
        )}

        <Section title="Columns" count={info.columns.length}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={cn(th, "w-9")}>#</th>
                <th className={th}>Name</th>
                <th className={th}>Type</th>
                <th className={th}>Null</th>
                <th className={th}>Default</th>
                <th className={th}>Key / comment</th>
              </tr>
            </thead>
            <tbody>
              {info.columns.map((c) => {
                const fk = fkOf(c.name);
                const isKey = info.rowKey.includes(c.name);
                return (
                  <tr key={c.name} className="hover:bg-row-hover">
                    <td className={cn(td, "text-fg-3 tabular-nums")}>{c.position}</td>
                    <td className={cn(td, "font-data whitespace-nowrap")}>
                      <span className="mr-1.5 inline-block w-3 align-[-1px]">
                        {isKey ? <KeyRound className="size-3 text-json-keyword" /> : fk ? <Link2 className="size-3 text-accent-text" /> : null}
                      </span>
                      {c.name}
                    </td>
                    <td className={cn(td, "font-data text-json-bson")}>
                      {c.typeName}
                      {c.enumValues && (
                        <span className="ml-2 font-sans text-xs text-fg-3" title={c.enumValues.join(", ")}>
                          enum · {c.enumValues.length} values
                        </span>
                      )}
                    </td>
                    <td className={td}>
                      {c.nullable ? (
                        <span className="text-fg-3">nullable</span>
                      ) : (
                        <span className="rounded-sm bg-fg/7 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-fg-2">NOT NULL</span>
                      )}
                    </td>
                    <td className={cn(td, "max-w-[280px] truncate font-data text-fg-3")} title={c.default ?? c.generated ?? undefined}>
                      {c.identity ? `identity (${c.identity === "a" ? "always" : "by default"})` : c.generated ? `generated: ${c.generated}` : (c.default ?? "")}
                    </td>
                    <td className={cn(td, "text-fg-2")}>
                      {fk ? (
                        <span className="font-data">
                          → {fk.refSchema === info.schema ? "" : `${fk.refSchema}.`}
                          {fk.refTable}.{fk.refColumns?.[0]}
                        </span>
                      ) : (
                        c.comment
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>

        {!isView && (
          <Section title="Constraints" count={info.constraints.length}>
            {info.constraints.length === 0 ? (
              <p className="px-3.5 py-2 text-sm text-fg-3">None</p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={th}>Name</th>
                    <th className={th}>Kind</th>
                    <th className={th}>Definition</th>
                  </tr>
                </thead>
                <tbody>
                  {info.constraints.map((c) => (
                    <tr key={c.name} className="hover:bg-row-hover">
                      <td className={cn(td, "font-data whitespace-nowrap")}>{c.name}</td>
                      <td className={td}>
                        <span className={cn("rounded-sm bg-fg/7 px-1.5 py-0.5 text-xs font-medium", CONSTRAINT_KIND[c.kind]?.className)}>
                          {CONSTRAINT_KIND[c.kind]?.label ?? c.kind}
                        </span>
                      </td>
                      <td className={td}>
                        <SqlText text={c.definition} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        )}

        {info.referencedBy.length > 0 && (
          <Section title="Referenced by" count={info.referencedBy.length}>
            <table className="w-full border-collapse">
              <tbody>
                {info.referencedBy.map((r) => (
                  <tr key={`${r.schema}.${r.table}.${r.name}`} className="hover:bg-row-hover">
                    <td className={cn(td, "font-data")}>
                      {r.schema}.{r.table}({r.columns.join(", ")})
                    </td>
                    <td className={cn(td, "font-data text-fg-3")}>→ ({r.refColumns.join(", ")})</td>
                    <td className={cn(td, "font-data text-fg-3")}>{r.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {info.kind !== "v" && (
          <Section
            title="Indexes"
            count={info.indexes.length}
            action={
              <>
                <span className="font-normal text-fg-3">scans since the statistics were reset</span>
                {info.kind !== "f" && (
                  <Button variant="ghost" size="sm" title="Build a CREATE INDEX for this table in a console" onClick={() => setNewIndexOpen(true)}>
                    <Plus />
                    New index…
                  </Button>
                )}
              </>
            }
          >
            {info.indexes.length === 0 ? <p className="px-3.5 py-2 text-sm text-fg-3">None</p> : <IndexesTable tab={tab} indexes={info.indexes} />}
          </Section>
        )}

        {info.triggers.length > 0 && (
          <Section title="Triggers" count={info.triggers.length}>
            <TriggersTable tab={tab} triggers={info.triggers} canToggle={!isView} />
          </Section>
        )}

        <TimescaleTail tab={tab} ts={ts} />
      </div>
      {newIndexOpen && <NewIndexDialog tab={tab} columns={info.columns} onClose={() => setNewIndexOpen(false)} />}
      {/* Beside the tables only when they keep room: the DDL also opens in a console. */}
      <aside className="flex w-[380px] shrink-0 flex-col border-l border-line @max-[1080px]:hidden">
        <div className="flex h-9 flex-none items-center gap-1.5 border-b border-line-soft pr-1.5 pl-3">
          <span className="font-semibold">DDL</span>
          <span className="flex-1 truncate font-mono text-xs text-fg-3">from the catalog</span>
          <Button variant="ghost" size="icon" title="Open in a SQL console" aria-label="Open in a SQL console" onClick={openDdl}>
            <SquareTerminal />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Copy DDL"
            aria-label="Copy DDL"
            onClick={() => void navigator.clipboard.writeText(info.ddl).then(() => toast.success("Copied the DDL"))}
          >
            <Copy />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <SqlText text={info.ddl} className="px-3 py-2 whitespace-pre" />
        </div>
      </aside>
    </div>
  );
}
