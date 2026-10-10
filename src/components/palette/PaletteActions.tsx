import {
  Activity,
  Database,
  DatabaseBackup,
  DatabaseZap,
  FileUp,
  FolderOpen,
  Moon,
  PanelRight,
  Plus,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Sun,
  Upload,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { useAssistantStore } from "../../store/assistantStore";
import type { ReactNode } from "react";
import { CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command";
import { api } from "../../lib/tauri";
import { SPLIT_LAYOUT_ORDER, SPLIT_LAYOUTS } from "../../lib/editorLayout";
import { useDumpStore } from "../../store/dumpStore";
import { useEditorLayoutStore } from "../../store/editorLayoutStore";
import { selectActiveTab, useSessionsStore } from "../../store/sessionsStore";
import { LayoutIcon } from "../tabs/LayoutPicker";
import { useThemeStore } from "../../store/themeStore";
import { openImportCsv, openRunSqlFile } from "../../store/transferStore";
import { useUiStore } from "../../store/uiStore";
import { HighlightMatch } from "./HighlightMatch";

interface PaletteActionsProps {
  search: string;
  /** Closes the palette, then runs the choice. */
  run: (action: () => void) => void;
}

interface PaletteAction {
  id: string;
  icon: ReactNode;
  label: string;
  where?: string;
  shortcut?: string;
  perform: () => void;
}

/** The palette's commands. */
export function PaletteActions({ search, run }: PaletteActionsProps) {
  const activeTab = useSessionsStore(selectActiveTab);
  const themeId = useThemeStore((s) => s.themeId);
  const layout = useEditorLayoutStore((s) => s.layout);

  const actions: PaletteAction[] = [
    {
      id: "new-connection",
      icon: <Plus />,
      label: "New connection",
      shortcut: "Ctrl N",
      perform: () => useUiStore.getState().setConnectionDialog({ mode: "new" }),
    },
  ];
  if (activeTab) {
    const tab = activeTab;
    actions.push({
      id: "new-console",
      icon: <SquareTerminal />,
      label: `New console on ${tab.database}`,
      where: tab.connection.name,
      perform: () =>
        useSessionsStore
          .getState()
          .openConsole(tab.connection, tab.database),
    });
    actions.push({
      id: "server-activity",
      icon: <Activity />,
      label: `Server activity of ${tab.database}`,
      where: tab.connection.name,
      perform: () => useSessionsStore.getState().openActivity(tab.connection, tab.database),
    });
    actions.push({
      id: "run-sql-file",
      icon: <FileUp />,
      label: `Run SQL file on ${tab.database}...`,
      where: tab.connection.name,
      perform: () => openRunSqlFile(tab.connection, tab.database),
    });
    if (tab.kind === "table" && ["r", "p"].includes(tab.relkind)) {
      actions.push({
        id: "import-csv",
        icon: <Upload />,
        label: `Import CSV into ${tab.schema}.${tab.table}...`,
        where: tab.connection.name,
        perform: () => openImportCsv(tab.connection, tab.database, tab.schema, tab.table),
      });
    }
    if (tab.kind === "table" || tab.kind === "diagram") {
      actions.push({
        id: "schema-diagram",
        icon: <Workflow />,
        label: `Schema diagram of ${tab.database}.${tab.schema}`,
        where: tab.connection.name,
        perform: () =>
          useSessionsStore
            .getState()
            .openDiagram(tab.connection, tab.database, tab.schema, tab.kind === "table" ? tab.table : undefined),
      });
    }
    actions.push(
      {
        id: "backup-database",
        icon: <DatabaseBackup />,
        label: `Back up ${tab.database} with pg_dump`,
        where: tab.connection.name,
        perform: () => useDumpStore.getState().open("backup", tab.connection, tab.database),
      },
      {
        id: "restore-database",
        icon: <DatabaseZap />,
        label: `Restore a backup into ${tab.database}`,
        where: tab.connection.name,
        perform: () => useDumpStore.getState().open("restore", tab.connection, tab.database),
      },
    );
    actions.push({
      id: "open-to-side",
      icon: <PanelRight />,
      label: "Open the tab to the side",
      shortcut: "Ctrl \\",
      perform: () => {
        if (!useEditorLayoutStore.getState().openToSide(tab.id)) {
          toast("All four panes are in use", { description: "Close a pane, or drop the tab onto one to replace it." });
        }
      },
    });
    SPLIT_LAYOUT_ORDER.forEach((kind, i) => {
      if (kind === layout) return;
      actions.push({
        id: `layout-${kind}`,
        icon: <LayoutIcon layout={kind} />,
        label: kind === "single" ? "Editor: single pane" : `Split the editor: ${SPLIT_LAYOUTS[kind].label}`,
        shortcut: `Ctrl Alt ${i + 1}`,
        perform: () => useEditorLayoutStore.getState().setLayout(kind),
      });
    });
  }
  const other = themeId === "dark" ? "light" : "dark";
  actions.push(
    {
      id: "theme",
      icon: other === "light" ? <Sun /> : <Moon />,
      label: `Switch to ${other} theme`,
      perform: () => useThemeStore.getState().setTheme(other),
    },
    {
      id: "toggle-explorer",
      icon: <Database />,
      label: "Toggle Explorer",
      shortcut: "Ctrl B",
      perform: () => useUiStore.getState().toggleSidePanel("explorer"),
    },
    {
      id: "assistant",
      icon: <Sparkles />,
      label: "Ask the Assistant",
      shortcut: "Ctrl L",
      perform: () => useAssistantStore.getState().openPanel(),
    },
    {
      id: "assistant-settings",
      icon: <SlidersHorizontal />,
      label: "Assistant settings",
      perform: () => useAssistantStore.getState().openPanel("setup"),
    },
    {
      id: "open-logs",
      icon: <FolderOpen />,
      label: "Open logs folder",
      perform: () =>
        api.openLogDir().catch((e) =>
          toast.error("Couldn't open the logs folder", { description: String(e) }),
        ),
    },
  );

  return (
    <CommandGroup heading="Actions">
      {actions.map((action) => (
        <CommandItem
          key={action.id}
          value={`action:${action.id}`}
          keywords={[action.label]}
          onSelect={() => run(action.perform)}
        >
          {action.icon}
          <span className="min-w-0 truncate">
            <HighlightMatch text={action.label} query={search} />
          </span>
          {action.where && <span className="shrink-0 text-sm text-fg-3">{action.where}</span>}
          {action.shortcut && <CommandShortcut>{action.shortcut}</CommandShortcut>}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
