import { Activity, SquareTerminal, Table, Workflow } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Tab } from "../../store/sessionsStore";

/** What a tab is called: its table (schema-qualified outside public), its schema's diagram, the database's activity, or for a console its database. */
export function tabName(tab: Tab): string {
  if (tab.kind === "table") return tab.schema === "public" ? tab.table : `${tab.schema}.${tab.table}`;
  if (tab.kind === "diagram") return `${tab.schema} diagram`;
  if (tab.kind === "activity") return `${tab.database} activity`;
  return `${tab.database} console${tab.number > 1 ? ` ${tab.number}` : ""}`;
}

/** The icon a tab is shown with. */
export function tabIcon(tab: Tab): LucideIcon {
  if (tab.kind === "activity") return Activity;
  return tab.kind === "console" ? SquareTerminal : tab.kind === "diagram" ? Workflow : Table;
}
