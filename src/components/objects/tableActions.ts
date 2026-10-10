import { toast } from "sonner";
import { api } from "../../lib/tauri";
import { objectsApi } from "../../lib/objectsApi";
import { deleteTemplateSql, insertTemplateSql, qualify, selectAllSql, updateTemplateSql } from "../../lib/objectsSql";
import { MAINTENANCE_LABEL } from "../../lib/tableActions";
import type { GenerateKind } from "../../lib/tableActions";
import { confirm } from "../../store/confirmStore";
import type { TabConnection } from "../../store/sessionsStore";
import type { MaintenanceAction } from "../../types/objects";
import { formatDuration } from "../../lib/activity";
import { openSql } from "./openSql";

interface Target {
  connection: TabConnection;
  sessionId: string;
  database: string;
  schema: string;
  table: string;
}

/** Runs a maintenance statement on the table. TRUNCATE asks first. */
export async function runMaintenance(t: Target, action: MaintenanceAction): Promise<void> {
  const name = qualify(t.schema, t.table);
  if (action === "truncate") {
    const ok = await confirm({
      title: `Truncate ${t.schema}.${t.table}?`,
      message: `Runs TRUNCATE TABLE ${name} in ${t.database}: every row is deleted at once, without per-row triggers, and the rows cannot be brought back. It fails if another table's foreign key points here.`,
      confirmLabel: "Truncate",
      danger: true,
    });
    if (!ok) return;
  }
  const label = MAINTENANCE_LABEL[action].replace("…", "");
  const run = objectsApi.runMaintenance(t.sessionId, t.database, t.schema, t.table, action);
  toast.promise(run, {
    loading: `${label} ${name}…`,
    success: (ms) => `${label} ${name} finished in ${formatDuration(ms)}`,
    error: (e) => `${label} ${name} failed: ${String(e)}`,
  });
  await run.catch(() => {});
}

/** Opens SQL for the table in a new console; the table is described first for its columns and key. */
export async function generateSql(t: Target, kind: GenerateKind): Promise<void> {
  try {
    const info = await api.describeTable(t.sessionId, t.database, t.schema, t.table);
    const sql = { select: selectAllSql, insert: insertTemplateSql, update: updateTemplateSql, delete: deleteTemplateSql, ddl: (i: typeof info) => i.ddl }[kind](info);
    openSql(t.connection, t.database, sql);
  } catch (e) {
    toast.error(`Couldn't read ${t.schema}.${t.table}`, { description: String(e) });
  }
}
