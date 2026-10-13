import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatInt } from "@/lib/format";
import { flatten, nodeLabel, type PlanNode, type Row } from "@/lib/explainPlan";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { ExplainResult } from "../../types/pg";
import { SqlText } from "./SqlText";

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
                        <span className="font-semibold text-fg">{nodeLabel(n)}</span>
                        {n["Node Type"] === "Custom Scan" && <span className="text-fg-3"> custom scan</span>}
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
