import { Power, PowerOff, Trash2 } from "lucide-react";
import type { TriggerInfo } from "../../types/pg";
import type { TableTab } from "../../store/sessionsStore";
import { ActionMenuButton } from "@/components/common/ActionMenu";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { cn } from "@/lib/utils";
import { dropTriggerSql, toggleTriggerSql } from "@/lib/objectsSql";
import { SqlText } from "../console/SqlText";
import { openSql } from "./openSql";

const STATE: Record<string, { label: string; className: string }> = {
  O: { label: "enabled", className: "text-fg-3" },
  D: { label: "disabled", className: "text-warn" },
  R: { label: "replica only", className: "text-fg-2" },
  A: { label: "always", className: "text-fg-2" },
};

const th = "sticky top-[34px] z-[2] h-[30px] bg-panel px-3.5 text-left text-sm font-medium whitespace-nowrap text-fg-2 border-b border-line";
const td = "border-b border-line-soft px-3.5 py-1 align-top";

/** The table's triggers: when they fire, what they run, and actions that open the SQL for them in a console. */
export function TriggersTable({ tab, triggers, canToggle }: { tab: TableTab; triggers: TriggerInfo[]; canToggle: boolean }) {
  const open = (sql: string) => openSql(tab.connection, tab.database, sql);

  function entries(t: TriggerInfo): MenuEntry[] {
    const off = t.enabledState === "D";
    return [
      { heading: t.name },
      {
        label: off ? "Enable trigger" : "Disable trigger",
        icon: off ? Power : PowerOff,
        // ALTER TABLE ... DISABLE TRIGGER is refused on views
        disabled: !canToggle,
        onSelect: () => open(toggleTriggerSql(tab.schema, tab.table, t.name, off)),
      },
      { label: "Drop trigger", icon: Trash2, danger: true, onSelect: () => open(dropTriggerSql(tab.schema, tab.table, t.name)) },
    ];
  }

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={th}>Name</th>
          <th className={th}>Fires</th>
          <th className={th}>Level</th>
          <th className={th}>Function</th>
          <th className={th}>State</th>
          <th className={cn(th, "w-9")} />
        </tr>
      </thead>
      <tbody>
        {triggers.map((t) => {
          const state = STATE[t.enabledState] ?? STATE.O;
          return (
            <tr key={t.name} className="group hover:bg-row-hover">
              <td className={td}>
                <div className={cn("font-data whitespace-nowrap", !t.enabled && "opacity-60")}>{t.name}</div>
                <SqlText text={t.definition} className={cn("mt-0.5 block text-xs text-fg-3", !t.enabled && "opacity-60")} />
              </td>
              <td className={cn(td, "whitespace-nowrap")}>
                <span className="font-medium text-fg-2">{t.timing}</span> <span className="text-fg-2">{t.events.join(" OR ")}</span>
              </td>
              <td className={cn(td, "text-fg-2")}>FOR EACH {t.level.toUpperCase()}</td>
              <td className={cn(td, "font-data text-fg-2")}>{t.function}</td>
              <td className={cn(td, "whitespace-nowrap", state.className)}>{state.label}</td>
              <td className={cn(td, "text-right")}>
                <ActionMenuButton entries={() => entries(t)} label={`Actions for trigger ${t.name}`} align="end" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
