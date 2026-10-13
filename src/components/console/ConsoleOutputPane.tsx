import { useId, useState } from "react";
import { CircleAlert, CircleCheck, Download, LoaderCircle } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "../../lib/tauri";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ConsoleSession } from "../../store/consoleStore";
import { useConsoleStore } from "../../store/consoleStore";
import type { Tab } from "../../store/sessionsStore";
import type { ExportFormat, StatementResult } from "../../types/pg";
import { ResultGrid } from "../grid/ResultGrid";
import { ConsoleOutputTabs } from "./ConsoleOutputTabs";
import type { OutputTabOption } from "./ConsoleOutputTabs";
import { ExplainView } from "./ExplainView";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** What a statement did, the way psql reports it. */
export function statementSummary(r: StatementResult): string {
  if (r.error) return `${r.command || "Statement"} failed`;
  // Truncated: only the rows kept were read, so the total isn't known.
  if (r.returnsRows) return `${formatInt(r.rowCount)}${r.truncated ? "+" : ""} ${r.rowCount === 1 && !r.truncated ? "row" : "rows"}`;
  if (["INSERT", "UPDATE", "DELETE", "MERGE", "COPY"].includes(r.command)) return `${r.command} ${formatInt(r.rowCount)}`;
  return r.command || "OK";
}

async function exportResult(result: StatementResult, format: ExportFormat, baseName: string) {
  const path = await save({
    defaultPath: `${baseName}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (!path) return;
  try {
    const summary = await api.exportRows(result.columns, result.rows, format, path);
    toast.success(`Exported ${formatInt(summary.rowsWritten)} rows`, { description: path });
  } catch (e) {
    toast.error("Export failed", { description: String(e) });
  }
}

/** The console's output: a tab per result set, Messages, and the plan when explained. */
export function ConsoleOutputPane({ tab, session }: { tab: Tab; session: ConsoleSession | undefined }) {
  const idPrefix = useId();
  const setOutput = useConsoleStore((s) => s.setOutput);
  const [selected, setSelected] = useState<number | null>(null);
  const run = session?.run ?? null;
  const output = session?.output ?? { kind: "result", index: 0 };
  const running = session?.running ?? false;

  const results = run?.results ?? [];
  const tabs: OutputTabOption[] = results
    .filter((r) => r.returnsRows || r.error)
    .map((r) => ({
      id: `r${r.index}`,
      label: r.error ? `Error` : `Result ${r.index + 1}`,
      count: r.error ? undefined : r.rowCount,
    }));
  tabs.push({
    id: "messages",
    label: "Messages",
    count: run ? results.length + run.notices.length : undefined,
  });
  if (session?.explain || session?.explaining || session?.explainError) tabs.push({ id: "explain", label: "Plan" });

  const current =
    output.kind === "explain" ? "explain" : output.kind === "messages" ? "messages" : tabs.some((t) => t.id === `r${output.index}`) ? `r${output.index}` : (tabs[0]?.id ?? "messages");
  const currentResult = current.startsWith("r") ? results[Number(current.slice(1))] : undefined;
  const failed = results.find((r) => r.error);
  const ran = run !== null || running || session?.error;

  function change(id: string) {
    setSelected(null);
    if (id === "messages") setOutput(tab.id, { kind: "messages" });
    else if (id === "explain") setOutput(tab.id, { kind: "explain" });
    else setOutput(tab.id, { kind: "result", index: Number(id.slice(1)) });
  }

  const baseName = tab.kind === "table" ? `${tab.table}-result` : `${tab.database}-result`;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-editor">
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line-soft pr-2.5 pl-1.5">
        <div className="min-w-0 overflow-x-auto">
          <ConsoleOutputTabs tabs={tabs} value={current} onChange={change} idPrefix={idPrefix} />
        </div>
        <span className="flex-1" />
        {currentResult && !currentResult.error && currentResult.returnsRows && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" title="Export this result">
                <Download />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void exportResult(currentResult, "csv", baseName)}>CSV</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportResult(currentResult, "json", baseName)}>JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="flex shrink-0 items-center gap-1.5 text-sm text-fg-2" role="status">
          {running ? (
            <>
              <LoaderCircle className="size-3 animate-spin" aria-hidden />
              Running…
            </>
          ) : session?.error || failed ? (
            <>
              <CircleAlert className="size-3 text-danger" aria-hidden />
              Failed
            </>
          ) : run ? (
            <>
              <CircleCheck className="size-3 text-ok" aria-hidden />
              {results.length === 1 ? statementSummary(results[0]) : `${results.length} statements`} · {formatDuration(run.elapsedMs)}
            </>
          ) : null}
        </span>
      </div>
      <div role="tabpanel" id={`${idPrefix}-panel`} className="flex min-h-0 flex-1 flex-col">
        {session?.error && (
          <div role="alert" className="flex-none border-b border-line bg-danger/8 px-3 py-2 font-data text-sm whitespace-pre-wrap text-danger">
            {session.error}
          </div>
        )}
        {/* an EXPLAIN before anything ran still has its plan to show */}
        {!ran && current !== "explain" ? (
          <div className="grid flex-1 place-items-center p-6 text-center text-fg-3">
            <p className="flex flex-wrap items-center justify-center gap-1.5">
              Run the statement at the caret
              <span className="inline-flex gap-1">
                <Kbd>Ctrl</Kbd>
                <Kbd>Enter</Kbd>
              </span>
              , or all of them
              <span className="inline-flex gap-1">
                <Kbd>Ctrl</Kbd>
                <Kbd>Shift</Kbd>
                <Kbd>Enter</Kbd>
              </span>
            </p>
          </div>
        ) : current === "explain" ? (
          session?.explaining ? (
            <div className="grid flex-1 place-items-center text-sm text-fg-3">Explaining…</div>
          ) : session?.explainError ? (
            <div className="m-3 font-data text-sm whitespace-pre-wrap text-danger">{session.explainError}</div>
          ) : session?.explain ? (
            <ExplainView explain={session.explain} />
          ) : null
        ) : current === "messages" ? (
          <Messages session={session!} />
        ) : currentResult?.error ? (
          <StatementError result={currentResult} />
        ) : currentResult ? (
          <>
            {currentResult.truncated && (
              <p className="flex-none border-b border-line-soft bg-warn/8 px-3 py-1 text-xs text-fg-2">
                Showing the first {formatInt(currentResult.rows.length)} rows; there are more. Add a LIMIT, or export the query for all of them.
              </p>
            )}
            <ResultGrid
              columns={currentResult.columns}
              rows={currentResult.rows}
              selectedRow={selected}
              onSelectRow={setSelected}
              aria-label={`Result ${currentResult.index + 1}`}
              className={cn("flex-1", running && "opacity-60")}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function StatementError({ result }: { result: StatementResult }) {
  const e = result.error!;
  return (
    <div className="m-3 flex flex-col gap-1.5 rounded-md border border-danger/40 bg-danger/6 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-danger">
        <CircleAlert className="size-4" />
        {e.severity ?? "ERROR"}
        {e.code && <span className="font-data text-xs font-normal text-fg-3">SQLSTATE {e.code}</span>}
      </div>
      <p className="font-data whitespace-pre-wrap text-fg">{e.message}</p>
      {e.detail && <p className="font-data whitespace-pre-wrap text-fg-2">Detail: {e.detail}</p>}
      {e.hint && <p className="font-data whitespace-pre-wrap text-fg-2">Hint: {e.hint}</p>}
      {e.position && <p className="text-xs text-fg-3">Marked in the editor at character {e.position} of statement {result.index + 1}.</p>}
    </div>
  );
}

function Messages({ session }: { session: ConsoleSession }) {
  const run = session.run;
  if (!run) return null;
  return (
    <div className="min-h-0 flex-1 overflow-auto py-2 font-data text-data">
      {run.results.map((r) => (
        <div key={r.index} className="flex gap-3.5 px-3.5 leading-5">
          <span className="w-6 shrink-0 text-right text-fg-3">{r.index + 1}</span>
          <span className={r.error ? "text-danger" : "text-fg"}>{r.error ? `${r.error.message}${r.error.code ? ` (${r.error.code})` : ""}` : statementSummary(r)}</span>
          <span className="text-fg-3">{formatDuration(r.elapsedMs)}</span>
        </div>
      ))}
      {run.notices.map((n, i) => (
        <div key={`n${i}`} className="flex gap-3.5 px-3.5 leading-5">
          <span className="w-6 shrink-0 text-right text-fg-3">·</span>
          <span className={n.severity === "WARNING" ? "text-warn" : "text-fg-2"}>
            {n.severity}: {n.message}
            {n.detail ? ` — ${n.detail}` : ""}
            {n.hint ? ` (hint: ${n.hint})` : ""}
          </span>
        </div>
      ))}
      <div className="flex gap-3.5 px-3.5 leading-5 text-fg-3">
        <span className="w-6" />
        <span>
          {run.transaction === "active"
            ? "A transaction is open on this tab: COMMIT or ROLLBACK to end it."
            : run.transaction === "failed"
              ? "The transaction failed; only ROLLBACK works now."
              : run.transaction === "unknown"
                ? "Transaction state unknown (pooler mode)."
                : "Each statement committed on its own."}
        </span>
      </div>
    </div>
  );
}
