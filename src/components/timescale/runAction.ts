import { toast } from "sonner";
import { formatDuration } from "@/lib/activity";
import { timescaleApi } from "@/lib/timescaleApi";
import { confirm } from "../../store/confirmStore";
import type { TimescaleAction } from "../../types/timescale";

export interface ActionTarget {
  sessionId: string;
  database: string;
}

export interface RunOptions {
  /** What the toast calls it, e.g. "Refresh public.metrics_hourly". */
  label: string;
  /** Ask first, showing the statement. Off when a dialog already showed it. */
  ask?: { title: string; detail: string; confirmLabel: string; danger?: boolean; typeToConfirm?: string };
}

/**
 * Runs one TimescaleDB action: shows the statement it will send and asks,
 * then reports how it went. Resolves to whether it ran and succeeded.
 */
export async function runTimescaleAction(t: ActionTarget, action: TimescaleAction, options: RunOptions): Promise<boolean> {
  if (options.ask) {
    let sql: string;
    try {
      sql = await timescaleApi.actionSql(t.sessionId, t.database, action);
    } catch (e) {
      toast.error(`${options.label} failed`, { description: String(e) });
      return false;
    }
    const ok = await confirm({
      title: options.ask.title,
      message: options.ask.detail,
      sql,
      confirmLabel: options.ask.confirmLabel,
      danger: options.ask.danger,
      typeToConfirm: options.ask.typeToConfirm,
    });
    if (!ok) return false;
  }
  const run = timescaleApi.action(t.sessionId, t.database, action);
  toast.promise(run, {
    loading: `${options.label}…`,
    success: (ms) => `${options.label} finished in ${formatDuration(ms)}`,
    error: (e) => `${options.label} failed: ${String(e)}`,
  });
  return run.then(
    () => true,
    () => false,
  );
}
