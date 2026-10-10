import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Download, KeyRound, Link2, RefreshCw, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { api } from "../../lib/tauri";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useConnectionColor } from "@/lib/connectionColor";
import { BOX_W, HEAD_H, ROW_H, layoutDiagram, neighbourhood, shortType } from "../../lib/diagramLayout";
import type { Box, Layout } from "../../lib/diagramLayout";
import { diagramToSvg } from "../../lib/diagramSvg";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSessionsStore } from "../../store/sessionsStore";
import type { DiagramTab } from "../../store/sessionsStore";
import type { SchemaDiagram } from "../../types/pg";
import { Button } from "@/components/ui/button";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { SegmentedControl } from "@/components/ui/segmented-control";

type Scope = "all" | "around";
interface View {
  x: number;
  y: number;
  k: number;
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A schema's tables and the keys between them, drawn; click traces, double-click opens. */
export const DiagramTabView = memo(function DiagramTabView({ tab }: { tab: DiagramTab }) {
  const session = useConnectionsStore((s) => s.sessions[tab.connection.id]);
  const color = useConnectionColor(tab.connection.id);
  const sessionId = session?.sessionId;
  const [data, setData] = useState<SchemaDiagram | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(tab.focus);
  const [scope, setScope] = useState<Scope>(tab.focus ? "around" : "all");

  // opened again from another table: look at that one
  useEffect(() => {
    if (tab.focus) {
      setSelected(tab.focus);
      setScope("around");
    }
  }, [tab.focus]);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api.schemaDiagram(sessionId, tab.database, tab.schema));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, tab.database, tab.schema]);

  useEffect(() => {
    void load();
  }, [load]);

  const around = scope === "around" ? selected : null;
  const layout = useMemo(() => {
    if (!data) return null;
    const near = around ? neighbourhood(around, data.foreignKeys, tab.schema) : null;
    const tables = near ? data.tables.filter((t) => near.has(t.name)) : data.tables;
    return layoutDiagram(tab.schema, tables, data.foreignKeys);
  }, [data, around, tab.schema]);

  function open(name: string) {
    const table = data?.tables.find((t) => t.name === name);
    if (!table || !sessionId) return;
    void useSessionsStore.getState().openTable(sessionId, tab.connection, tab.database, tab.schema, name, table.kind);
  }

  async function exportSvg() {
    if (!layout) return;
    const path = await save({
      defaultPath: `${tab.database}-${tab.schema}.svg`,
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (!path) return;
    try {
      await api.saveSvg(path, diagramToSvg(layout, `${tab.database}.${tab.schema}`));
      toast.success("Diagram exported", { description: path });
    } catch (e) {
      toast.error("Export failed", { description: String(e) });
    }
  }

  const count = data?.tables.length ?? 0;
  return (
    <div className="@container flex h-full min-h-0 flex-col bg-editor">
      <div className="flex h-9 flex-none items-center gap-2 border-b border-line pr-2 pl-2.5">
        <span
          className="inline-flex h-[26px] min-w-0 shrink items-center gap-1.5 rounded-md bg-fg/6 px-2 text-sm text-fg-2"
          title={`${tab.database}.${tab.schema} on ${tab.connection.name}`}
        >
          <ConnectionChip name={tab.connection.name} color={color} size="sm" />
          <span className="truncate font-data font-medium text-fg">
            {tab.database}.{tab.schema}
          </span>
        </span>
        <SegmentedControl<Scope>
          aria-label="Scope"
          value={around ? "around" : "all"}
          onChange={(v) => setScope(v)}
          options={[
            {
              value: "all",
              label: (
                <>
                  All tables <span className="text-fg-3">{count}</span>
                </>
              ),
            },
            {
              value: "around",
              label: selected ? <span className="max-w-40 truncate">Around {selected}</span> : "Around a table",
              title: selected ? `${selected} and the tables its keys touch` : "Select a table first",
            },
          ]}
        />
        <span className="flex-1" />
        <Button variant="ghost" title="Read the schema again" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn(loading && "animate-spin")} />
          <span className="@max-[640px]:hidden">Refresh</span>
        </Button>
        <Button variant="ghost" title="Save the diagram as an SVG file" disabled={!layout} onClick={() => void exportSvg()}>
          <Download />
          <span className="@max-[640px]:hidden">Export SVG</span>
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        {error ? (
          <div className="m-4 font-data text-sm whitespace-pre-wrap text-danger">{error}</div>
        ) : !layout ? (
          <div className="grid flex-1 place-items-center text-sm text-fg-3">{loading ? "Reading the schema…" : ""}</div>
        ) : count === 0 ? (
          <div className="grid flex-1 place-items-center text-sm text-fg-3">No tables in {tab.schema}.</div>
        ) : (
          <>
            <DiagramCanvas
              layout={layout}
              selected={selected}
              keysNear={selected && data ? neighbourhood(selected, data.foreignKeys, tab.schema) : null}
              onSelect={(name) => {
                setSelected(name);
                if (!name) setScope("all");
              }}
              onOpen={open}
            />
            {data && (
              <DiagramInspector
                data={data}
                schema={tab.schema}
                selected={selected}
                onSelect={setSelected}
                onOpen={open}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
});

interface CanvasProps {
  layout: Layout;
  selected: string | null;
  /** The selected table and its neighbours: the rest dims. */
  keysNear: Set<string> | null;
  onSelect: (name: string | null) => void;
  onOpen: (name: string) => void;
}

function DiagramCanvas({ layout, selected, keysNear, onSelect, onOpen }: CanvasProps) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  // the table under the pointer is read at pointerdown: with the pointer
  // captured, later events all land on the canvas itself
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; table: string | null } | null>(null);
  const lastClick = useRef<{ table: string; at: number } | null>(null);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const k = clampZoom(Math.min((width - 32) / layout.width, (height - 32) / layout.height, 1));
    setView({ k, x: Math.max(16, (width - layout.width * k) / 2), y: Math.max(16, (height - layout.height * k) / 2) });
  }, [layout]);

  // a new picture (scope, refresh) starts fitted
  useLayoutEffect(() => fit(), [fit]);

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms at the pointer; the wheel alone pans.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        setView((v) => {
          const k = clampZoom(v.k * Math.exp(-e.deltaY * 0.01));
          return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k };
        });
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  function zoomBy(factor: number) {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setView((v) => {
      const k = clampZoom(v.k * factor);
      return { k, x: width / 2 - ((width / 2 - v.x) / v.k) * k, y: height / 2 - ((height / 2 - v.y) / v.k) * k };
    });
  }

  function onPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    const g = (e.target as Element).closest<SVGGElement>("[data-table]");
    const table = g && g.dataset.stub !== "1" ? (g.dataset.table ?? null) : null;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, table };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    // a click, not a drag: on a table selects it (twice quickly opens it), elsewhere clears
    const now = performance.now();
    if (d.table && lastClick.current?.table === d.table && now - lastClick.current.at < 400) {
      lastClick.current = null;
      onOpen(d.table);
      return;
    }
    lastClick.current = d.table ? { table: d.table, at: now } : null;
    onSelect(d.table);
  }

  return (
    <div
      ref={box}
      className="relative min-w-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
      style={{
        backgroundImage: "radial-gradient(circle, color-mix(in srgb, var(--color-fg) 9%, transparent) 1px, transparent 1px)",
        backgroundSize: `${20 * view.k}px ${20 * view.k}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
    >
      <svg className="absolute inset-0 h-full w-full select-none" role="img" aria-label="Schema diagram">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {layout.edges.map((e) => {
            const on = selected !== null && (e.from === selected || e.to === selected);
            return (
              <path
                key={`${e.key.table}.${e.key.name}`}
                d={e.d}
                fill="none"
                className={cn(on ? "stroke-accent" : "stroke-field-line", selected && !on && "opacity-35")}
                strokeWidth={on ? 1.5 : 1.25}
              >
                <title>{`${e.key.table}.${e.key.columns.join(", ")} → ${e.to}.${e.key.refColumns.join(", ")}`}</title>
              </path>
            );
          })}
          {layout.boxes.map((b) => (
            <TableBox key={b.name} box={b} selected={b.name === selected} dim={keysNear !== null && !keysNear.has(b.name) && !b.stub} />
          ))}
        </g>
      </svg>
      <div className="pointer-events-none absolute right-14 bottom-2.5 left-3 flex items-center gap-3 text-xs text-fg-3">
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <svg viewBox="0 0 34 12" className="h-3 w-[34px]" aria-hidden>
            <path d="M 2 6 H 32 M 12 6 L 2 1 M 12 6 L 2 11 M 26 1 L 26 11" fill="none" className="stroke-field-line" strokeWidth={1.25} />
          </svg>
          many → one
        </span>
        <span className="truncate @max-[980px]:hidden">Click a table to trace its keys · double-click to open it · Ctrl+wheel zooms</span>
      </div>
      <div className="absolute right-2.5 bottom-2.5 flex flex-col overflow-hidden rounded-md border border-line bg-panel" onPointerDown={(e) => e.stopPropagation()}>
        <ToolButton label="Zoom in" onClick={() => zoomBy(1.2)}>
          <ZoomIn />
        </ToolButton>
        <ToolButton label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
          <ZoomOut />
        </ToolButton>
        <ToolButton label="Fit to view" onClick={fit}>
          <Scan />
        </ToolButton>
      </div>
    </div>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-7 place-items-center text-fg-2 not-last:border-b not-last:border-line hover:bg-hover hover:text-fg [&_svg]:size-3.5"
    >
      {children}
    </button>
  );
}

function TableBox({ box: b, selected, dim }: { box: Box; selected: boolean; dim: boolean }) {
  const head = `M 0.5 6 a 5.5 5.5 0 0 1 5.5 -5.5 H ${BOX_W - 6} a 5.5 5.5 0 0 1 5.5 5.5 V ${HEAD_H} H 0.5 Z`;
  return (
    <g
      data-table={b.name}
      data-stub={b.stub ? "1" : undefined}
      transform={`translate(${b.x},${b.y})`}
      className={cn("cursor-pointer", dim && "opacity-45")}
    >
      <rect
        width={BOX_W}
        height={b.h}
        rx={6}
        className={cn("fill-panel", selected ? "stroke-accent" : "stroke-line")}
        strokeWidth={selected ? 1.5 : 1}
        strokeDasharray={b.stub ? "4 3" : undefined}
      />
      <path d={head} style={{ fill: "color-mix(in srgb, var(--color-fg) 6%, var(--color-panel))" }} />
      <line x1={0} x2={BOX_W} y1={HEAD_H} y2={HEAD_H} className="stroke-line" />
      <text x={12} y={19.5} className={cn("fill-fg text-[12.5px] font-semibold", b.stub && "fill-fg-2 font-medium")}>
        {clip(b.label, b.rowEstimate !== null ? 22 : 30)}
        <title>{b.label}</title>
      </text>
      {b.rowEstimate !== null && (
        <text x={BOX_W - 12} y={19.5} textAnchor="end" className="fill-fg-3 text-[11px]">
          ~{formatInt(b.rowEstimate)}
        </text>
      )}
      {b.columns.map((c) => {
        const type = shortType(c.type);
        return (
          <g key={c.name} transform={`translate(0,${HEAD_H + c.row * ROW_H})`}>
            {c.pk ? (
              <KeyRound x={10} y={5} width={12} height={12} className="text-json-keyword" />
            ) : c.fk ? (
              <Link2 x={10} y={5} width={12} height={12} className="text-accent-text" />
            ) : null}
            <text x={28} y={15} className={cn("font-data text-[11.5px]", c.pk || c.fk ? "fill-fg" : "fill-fg-2")}>
              {clip(c.name, Math.max(10, 30 - type.length))}
              <title>{`${c.name} ${c.type}${c.notNull ? " not null" : ""}`}</title>
            </text>
            <text x={BOX_W - 12} y={15} textAnchor="end" className="fill-fg-3 font-data text-[10.5px]">
              {clip(type, 16)}
            </text>
          </g>
        );
      })}
      {b.hidden > 0 && (
        <text x={28} y={HEAD_H + b.columns.length * ROW_H + 15} className="fill-fg-3 text-[11px] italic">
          +{b.hidden} more {b.hidden === 1 ? "column" : "columns"}
        </text>
      )}
    </g>
  );
}

interface InspectorProps {
  data: SchemaDiagram;
  schema: string;
  selected: string | null;
  onSelect: (name: string) => void;
  onOpen: (name: string) => void;
}

function DiagramInspector({ data, schema, selected, onSelect, onOpen }: InspectorProps) {
  const table = data.tables.find((t) => t.name === selected);
  const out = data.foreignKeys.filter((k) => k.table === selected);
  const inc = data.foreignKeys.filter((k) => k.refSchema === schema && k.refTable === selected);
  const row = "flex min-h-[26px] items-center gap-2 px-3 text-sm";
  const heading = "flex items-center gap-1.5 px-3 pt-3 pb-1 text-xs font-medium text-fg-2";
  return (
    <aside aria-label="Table" className="flex w-[300px] flex-none flex-col border-l border-line bg-panel @max-[760px]:hidden">
      {!table ? (
        <p className="m-0 p-4 text-sm text-fg-3">Click a table to see its keys.</p>
      ) : (
        <>
          <div className="flex h-[34px] flex-none items-center gap-2 border-b border-line-soft px-3">
            <span className="min-w-0 flex-1 truncate font-data text-sm font-medium text-fg">{table.name}</span>
            {table.rowEstimate !== null && <span className="text-xs text-fg-3">~{formatInt(table.rowEstimate)} rows</span>}
            <Button variant="ghost" size="icon-xs" title="Open the table" aria-label="Open the table" onClick={() => onOpen(table.name)}>
              <ArrowUpRight />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto pb-3">
            <div className={heading}>
              Columns <span className="text-fg-3">{table.columns.length}</span>
            </div>
            {table.columns.map((c) => (
              <div key={c.name} className={row}>
                <span className="grid w-3.5 shrink-0 place-items-center">
                  {c.pk ? <KeyRound className="size-3 text-json-keyword" /> : c.fk ? <Link2 className="size-3 text-accent-text" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate font-data text-fg">{c.name}</span>
                <span className="shrink-0 font-data text-xs text-fg-3">{shortType(c.type)}</span>
              </div>
            ))}
            <div className={heading}>
              References <span className="text-fg-3">{out.length}</span>
            </div>
            {out.length === 0 && <p className="m-0 px-3 text-sm text-fg-3">None</p>}
            {out.map((k) => {
              const inSchema = k.refSchema === schema;
              return (
                <button
                  key={k.name}
                  type="button"
                  disabled={!inSchema}
                  onClick={() => onSelect(k.refTable)}
                  className={cn(row, "w-full text-left enabled:hover:bg-row-hover")}
                  title={k.name}
                >
                  <Link2 className="size-3 shrink-0 text-accent-text" />
                  <span className="min-w-0 flex-1 truncate font-data text-fg">{k.columns.join(", ")}</span>
                  <span className="min-w-0 truncate font-data text-xs text-fg-2">
                    → {inSchema ? k.refTable : `${k.refSchema}.${k.refTable}`}
                  </span>
                  <span className="shrink-0 text-xs text-fg-3">n : 1</span>
                </button>
              );
            })}
            <div className={heading}>
              Referenced by <span className="text-fg-3">{inc.length}</span>
            </div>
            {inc.length === 0 && <p className="m-0 px-3 text-sm text-fg-3">None</p>}
            {inc.map((k) => (
              <button
                key={`${k.table}.${k.name}`}
                type="button"
                onClick={() => onSelect(k.table)}
                className={cn(row, "w-full text-left hover:bg-row-hover")}
                title={k.name}
              >
                <ArrowLeft className="size-3 shrink-0 text-fg-3" />
                <span className="min-w-0 flex-1 truncate font-data text-fg">{k.table}</span>
                <span className="min-w-0 truncate font-data text-xs text-fg-2">.{k.columns.join(", ")}</span>
                <span className="shrink-0 text-xs text-fg-3">1 : n</span>
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
