#!/usr/bin/env node
// Backend benchmark through the dev bridge (src-tauri/src/devbridge.rs):
// the same commands and the same JSON serialization the app's IPC uses, so
// before/after numbers of an optimization are comparable.
//
//   docker compose -f docker-compose.dev.yml up -d
//   (cd src-tauri && cargo build --release --features devbridge --bin devbridge)
//   src-tauri/target/release/devbridge &
//   node scripts/bench.mjs <connection id> [--runs 5] [--json out.json]
//
// Needs a `bench` database on the connection's server with a `big` table:
//   create table big as select g as id, md5(g::text) as hash, ... from generate_series(1, 1000000) g;
// (see the README's Benchmarks section for the exact statement).

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const BRIDGE = "http://127.0.0.1:1430";
const args = process.argv.slice(2);
const connectionId = args[0];
const runs = Number(args[args.indexOf("--runs") + 1]) || 5;
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
if (!connectionId) {
  console.error("usage: node scripts/bench.mjs <connection id> [--runs 5] [--json out.json]");
  process.exit(2);
}

async function call(cmd, callArgs = {}) {
  const started = performance.now();
  const response = await fetch(BRIDGE, { method: "POST", body: JSON.stringify({ cmd, args: callArgs }) });
  const text = await response.text();
  const ms = performance.now() - started;
  const answer = JSON.parse(text);
  if ("err" in answer) throw new Error(`${cmd}: ${answer.err}`);
  return { value: answer.ok, ms, bytes: text.length };
}

function bridgeRss() {
  try {
    const pid = execSync("pgrep -x devbridge").toString().trim().split("\n")[0];
    return Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) * 1024;
  } catch {
    return null;
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mb = (b) => (b / 1024 / 1024).toFixed(1);

const { value: session } = await call("connect", { id: connectionId });
const sessionId = session.sessionId;
const db = "bench";

const cases = [
  ["list databases", () => call("list_databases", { sessionId })],
  ["list schema objects", () => call("list_schema_objects", { sessionId, database: db, schema: "public" })],
  ["describe big", () => call("describe_table", { sessionId, database: db, schema: "public", table: "big" })],
  [
    "browse 100 rows",
    () =>
      call("browse_table", {
        sessionId, database: db, schema: "public", table: "big",
        input: { whereClause: null, orderBy: "id", limit: 100, offset: 0 }, executionId: null,
      }),
  ],
  [
    "browse 1000 rows, deep offset",
    () =>
      call("browse_table", {
        sessionId, database: db, schema: "public", table: "big",
        input: { whereClause: "qty > 1000", orderBy: "id", limit: 1000, offset: 500000 }, executionId: null,
      }),
  ],
  ["count with filter", () => call("count_rows", { sessionId, database: db, schema: "public", table: "big", whereClause: "flag", executionId: null })],
  ...[1000, 10000, 100000].map((n) => [
    `run_sql ${n} rows`,
    () => call("run_sql", { sessionId, database: db, tabId: "bench", sql: `SELECT * FROM big LIMIT ${n}`, caret: null, rowLimit: n, executionId: null }),
  ]),
  [
    "run_sql 1M rows, capped at 1000",
    () => call("run_sql", { sessionId, database: db, tabId: "bench", sql: "SELECT * FROM big", caret: null, rowLimit: 1000, executionId: null }),
  ],
  [
    "run_sql 200 small statements",
    () =>
      call("run_sql", {
        sessionId, database: db, tabId: "bench",
        sql: Array.from({ length: 200 }, (_, i) => `SELECT ${i} AS n;`).join("\n"), caret: null, rowLimit: 1000, executionId: null,
      }),
  ],
];

const rssBefore = bridgeRss();
const results = [];
for (const [name, fn] of cases) {
  await fn(); // warm up: plans, catalog caches, connections
  const times = [];
  let bytes = 0;
  for (let i = 0; i < runs; i++) {
    const r = await fn();
    times.push(r.ms);
    bytes = r.bytes;
  }
  const row = { name, medianMs: Number(median(times).toFixed(1)), minMs: Number(Math.min(...times).toFixed(1)), bytes };
  results.push(row);
  console.log(`${name.padEnd(34)} ${String(row.medianMs).padStart(9)} ms  (min ${row.minMs})  ${mb(bytes).padStart(7)} MB`);
}
const rssAfter = bridgeRss();
if (rssBefore !== null) console.log(`devbridge RSS: ${mb(rssBefore)} MB before, ${mb(rssAfter)} MB after`);
await call("release_tab", { sessionId, tabId: "bench" }).catch(() => {});
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ runs, results, rssBefore, rssAfter }, null, 2));
