import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatInt } from "@/lib/format";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { ExplainResult } from "../../types/pg";
import { SqlText } from "./SqlText";

/** One node of EXPLAIN (FORMAT JSON), as much of it as the tree shows. */
interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Schema?: string;
  Alias?: string;
  "Index Name"?: string;
  "Join Type"?: string;
  Strategy?: string;
  "Startup Cost"?: number;
  "Total Cost"?: number;
  "Plan Rows"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Actual Total Time"?: number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

interface Row {
  node: PlanNode;
  depth: number;
  selfMs: number | null;
  rows: number | null;
  estimate: number | null;
  warnings: string[];
  details: string[];
}

const DETAIL_KEYS = [
  "Index Cond",
  "Recheck Cond",
  "Filter",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "Sort Key",
  "Group Key",
  "One-Time Filter",
  "Output",
];

function flatten(node: PlanNode, depth: number, out: Row[]) {
  const loops = node["Actual Loops"] ?? 1;
  const total = node["Actual Total Time"] !== undefined ? node["Actual Total Time"] * loops : null;
  const childTotal = (node.Plans ?? []).reduce(
    (sum, c) => sum + (c["Actual Total Time"] !== undefined ? c["Actual Total Time"] * (c["Actual Loops"] ?? 1) : 0),
    0,
  );
  const rows = node["Actual Rows"] !== undefined ? node["Actual Rows"] * loops : null;
  const estimate = node["Plan Rows"] !== undefined ? node["Plan Rows"] * (node["Actual Loops"] !== undefined ? loops : 1) : null;
  const warnings: string[] = [];
  if (rows !== null && estimate !== null && Math.max(rows, 1) / Math.max(estimate, 1) >= 10) {
    warnings.push(`Planner expected ${formatInt(estimate)} rows, got ${formatInt(rows)}; ANALYZE may help`);
  } else if (rows !== null && estimate !== null && Math.max(estimate, 1) / Math.max(rows, 1) >= 100 && estimate > 1000) {
    warnings.push(`Planner expected ${formatInt(estimate)} rows, got ${formatInt(rows)}`);
  }
  const removed = node["Rows Removed by Filter"];
  if (node["Node Type"] === "Seq Scan" && removed !== undefined && rows !== null && removed > 1000 && removed > rows * 4) {
    warnings.push(`Reads ${formatInt(removed + rows)} rows to keep ${formatInt(rows)}: an index on the filter's columns may help`);
  }
  const details = DETAIL_KEYS.flatMap((k) => {
    const v = node[k];
    if (v === undefined || (k === "Output" && depth > 0)) return [];
    return [`${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`];
  });
  if (removed) details.push(`Rows Removed by Filter: ${formatInt(removed)}`);
  out.push({ node, depth, selfMs: total === null ? null : Math.max(0, total - childTotal), rows, estimate, warnings, details });
  for (const child of node.Plans ?? []) flatten(child, depth + 1, out);
}

/** EXPLAIN as a tree: each node's own time, actual against estimated rows, buffers, and what to look at. */
export function ExplainView({ explain, statement }: { explain: ExplainResult; statement?: string }) {
  const [view, setView] = useState<"tree" | "json">("tree");
  const root = (Array.isArray(explain.plan) ? explain.plan[0] : explain.plan) as Record<string, unknown> | undefined;
  const rows = useMemo(() => {
    const out: Row[] = [];
    if (root?.Plan) flatten(root.Plan as PlanNode, 0, out);
    return out;
  }, [root]);
  const maxSelf = Math.max(0.001, ...rows.map((r) => r.selfMs ?? 0));
  const maxCost = Math.max(0.001, ...rows.map((r) => r.node["Total Cost"] ?? 0));
  const planning = root?.["Planning Time"] as number | undefined;
  const execution = root?.["Execution Time"] as number | undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-4 border-b border-line-soft px-3.5 py-2 text-sm text-fg-2">
        <span>{explain.analyzed ? "EXPLAIN ANALYZE (rolled back)" : "EXPLAIN (plan only)"}</span>
        {planning !== undefined && (
          <span>
            Planning <b className="font-medium text-fg tabular-nums">{planning.toFixed(2)} ms</b>
          </span>
        )}
        {execution !== undefined && (
          <span>
            Execution <b className="font-medium text-fg tabular-nums">{execution.toFixed(2)} ms</b>
          </span>
        )}
        <span className="flex-1" />
        <SegmentedControl
          aria-label="Plan view"
          value={view}
          onChange={setView}
          options={[
            { value: "tree", label: "Tree" },
            { value: "json", label: "JSON" },
          ]}
        />
      </div>
      {view === "json" ? (
        <pre className="min-h-0 flex-1 overflow-auto px-3.5 py-2 font-data text-fg-2">{JSON.stringify(explain.plan, null, 2)}</pre>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {statement && <SqlText text={statement} className="border-b border-line-soft px-3.5 py-2 text-fg-2" />}
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-sm text-fg-2">
                <th className="sticky top-0 z-[1] h-7 border-b border-line bg-panel px-3 font-medium">Operation</th>
                <th className="sticky top-0 z-[1] h-7 border-b border-line bg-panel px-3 text-right font-medium">{explain.analyzed ? "Rows · est." : "Est. rows"}</th>
                <th className="sticky top-0 z-[1] h-7 border-b border-line bg-panel px-3 font-medium">{explain.analyzed ? "Self time" : "Cost"}</th>
                {explain.analyzed && <th className="sticky top-0 z-[1] h-7 border-b border-line bg-panel px-3 text-right font-medium">Loops</th>}
                {explain.analyzed && <th className="sticky top-0 z-[1] h-7 border-b border-line bg-panel px-3 text-right font-medium">Buffers</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const n = r.node;
                const hot = explain.analyzed ? (r.selfMs ?? 0) / maxSelf > 0.5 && rows.length > 1 : false;
                const bar = explain.analyzed ? (r.selfMs ?? 0) / maxSelf : (n["Total Cost"] ?? 0) / maxCost;
                const off = r.rows !== null && r.estimate !== null && Math.max(r.rows, 1) / Math.max(r.estimate, 1) >= 10;
                return (
                  <tr key={i} className={cn("align-top text-sm hover:bg-row-hover", hot && "bg-warn/6")}>
                    <td className="border-b border-line-soft px-3 py-1.5">
                      <div style={{ paddingLeft: r.depth * 18 }} className="relative">
                        {r.depth > 0 && (
                          <span
                            aria-hidden
                            className="absolute top-[-6px] h-[15px] w-2 rounded-bl-[3px] border-b border-l border-field-line"
                            style={{ left: r.depth * 18 - 12 }}
                          />
                        )}
                        <span className="font-semibold text-fg">
                          {n["Join Type"] && n["Node Type"].includes("Join") ? `${n["Join Type"]} ` : ""}
                          {n["Node Type"]}
                        </span>
                        {n["Relation Name"] && (
                          <>
                            <span className="text-fg-3"> on </span>
                            <span className="font-data text-json-key">
                              {n["Relation Name"]}
                              {n.Alias && n.Alias !== n["Relation Name"] ? ` ${n.Alias}` : ""}
                            </span>
                          </>
                        )}
                        {n["Index Name"] && (
                          <>
                            <span className="text-fg-3"> using </span>
                            <span className="font-data text-json-bson">{n["Index Name"]}</span>
                          </>
                        )}
                        {r.details.map((d) => (
                          <span key={d} className="block font-data text-[11.5px] leading-[17px] break-words text-fg-3">
                            {d}
                          </span>
                        ))}
                        {r.warnings.map((w) => (
                          <span key={w} className="mt-0.5 flex items-center gap-1 text-xs text-warn">
                            <AlertTriangle className="size-3" />
                            {w}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="border-b border-line-soft px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                      {r.rows !== null ? formatInt(r.rows) : ""}
                      {r.estimate !== null && (
                        <span className={cn(off ? "text-warn" : "text-fg-3")}>
                          {r.rows !== null ? " · " : ""}
                          {formatInt(r.estimate)}
                        </span>
                      )}
                    </td>
                    <td className="border-b border-line-soft px-3 py-1.5 whitespace-nowrap tabular-nums">
                      {explain.analyzed ? `${(r.selfMs ?? 0).toFixed(2)} ms` : (n["Total Cost"] ?? 0).toFixed(1)}
                      <span className="ml-2 inline-block h-1.5 w-20 overflow-hidden rounded-sm bg-line-soft align-middle">
                        <i className={cn("block h-full", hot ? "bg-warn" : "bg-accent")} style={{ width: `${bar * 100}%` }} />
                      </span>
                    </td>
                    {explain.analyzed && <td className="border-b border-line-soft px-3 py-1.5 text-right tabular-nums">{n["Actual Loops"] ?? ""}</td>}
                    {explain.analyzed && (
                      <td className="border-b border-line-soft px-3 py-1.5 text-right font-data text-[12px] whitespace-nowrap text-fg-3">
                        {n["Shared Hit Blocks"] || n["Shared Read Blocks"]
                          ? `hit=${n["Shared Hit Blocks"] ?? 0}${n["Shared Read Blocks"] ? ` read=${n["Shared Read Blocks"]}` : ""}`
                          : "—"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
