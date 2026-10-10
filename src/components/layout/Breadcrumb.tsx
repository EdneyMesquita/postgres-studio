import { Activity, Database, Layers, SquareTerminal, Table, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import type { Tab } from "../../store/sessionsStore";

interface BreadcrumbProps {
  tab: Tab;
}

interface CrumbProps {
  icon: ReactNode;
  children: ReactNode;
  /** The current place, in text color. */
  last?: boolean;
}

function Crumb({ icon, children, last }: CrumbProps) {
  return (
    <>
      <span aria-hidden className="text-fg-3">
        /
      </span>
      <span
        className={`flex min-w-0 items-center gap-1.5 px-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0 ${
          last ? "text-fg" : "text-fg-2"
        }`}
        aria-current={last ? "location" : undefined}
      >
        {icon}
        <span className="truncate">{children}</span>
      </span>
    </>
  );
}

/** Where the active tab runs: database / schema / table, or database / Console. */
export function Breadcrumb({ tab }: BreadcrumbProps) {
  return (
    <nav
      aria-label="Location"
      className="flex min-w-0 items-center gap-0.5 whitespace-nowrap max-[960px]:hidden"
    >
      <Crumb icon={<Database />}>{tab.database}</Crumb>
      {tab.kind === "table" ? (
        <>
          <Crumb icon={<Layers />}>{tab.schema}</Crumb>
          <Crumb icon={<Table />} last>
            {tab.table}
          </Crumb>
        </>
      ) : tab.kind === "diagram" ? (
        <>
          <Crumb icon={<Layers />}>{tab.schema}</Crumb>
          <Crumb icon={<Workflow />} last>
            Schema diagram
          </Crumb>
        </>
      ) : tab.kind === "activity" ? (
        <Crumb icon={<Activity />} last>
          Server activity
        </Crumb>
      ) : (
        <Crumb icon={<SquareTerminal />} last>
          Console
        </Crumb>
      )}
    </nav>
  );
}
