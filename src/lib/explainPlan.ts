import { formatInt } from "./format";

/** One node of EXPLAIN (FORMAT JSON), as much of it as the tree shows. */
export interface PlanNode {
  "Node Type": string;
  "Custom Plan Provider"?: string;
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
  /** TimescaleDB's DeferredChunkAppend keeps its single child here, not in Plans. */
  Plan?: PlanNode;
  [key: string]: unknown;
}

export interface Row {
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
  "Chunks excluded during startup",
  "Chunks excluded during runtime",
  "Runtime Exclusion",
  "Chunks Visited",
  "Order",
  "Hypertable",
  "Vectorized Filter",
  "Bulk Decompression",
  "Grouping Policy",
  "Startup Exclusion",
];

/** Every child a node has, whichever key the server wrote it under. */
export function childrenOf(node: PlanNode): PlanNode[] {
  return [...(node.Plans ?? []), ...(node.Plan ? [node.Plan] : [])];
}

/** What the tree calls a node: the extension's name for a custom scan, and `Join Type` ahead of a join's name. */
export function nodeLabel(node: PlanNode): string {
  if (node["Node Type"] === "Custom Scan" && node["Custom Plan Provider"]) return node["Custom Plan Provider"];
  if (node["Join Type"] && node["Node Type"].includes("Join")) return `${node["Join Type"]} ${node["Node Type"]}`;
  return node["Node Type"];
}

export function flatten(node: PlanNode, depth: number, out: Row[]) {
  const loops = node["Actual Loops"] ?? 1;
  const total = node["Actual Total Time"] !== undefined ? node["Actual Total Time"] * loops : null;
  const childTotal = childrenOf(node).reduce(
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
  for (const child of childrenOf(node)) flatten(child, depth + 1, out);
}
