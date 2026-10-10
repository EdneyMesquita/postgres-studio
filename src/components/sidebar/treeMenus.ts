import { Copy, FileCode, FileUp, FolderPlus, ListTree, Pencil, Plug, RefreshCw, SquareTerminal, Table, Trash2, Unplug, Upload, Workflow } from "lucide-react";
import { toast } from "sonner";
import type { MenuEntry } from "@/components/common/ActionMenu";

/** Copies a name for pasting into a query or a script. */
function copyName(name: string) {
  navigator.clipboard.writeText(name).then(
    () => toast.success(`Copied ${name}`),
    (e) => toast.error("Couldn't copy the name", { description: String(e) }),
  );
}

interface FolderMenu {
  hasConnections: boolean;
  /** How many connections in the folder, at any depth, are connected. */
  connectedCount: number;
  onNewFolder: () => void;
  onRename: () => void;
  onDisconnectAll: () => void;
  onDelete: () => void;
}

export function folderMenuEntries(m: FolderMenu): MenuEntry[] {
  return [
    { label: "New folder inside", icon: FolderPlus, onSelect: m.onNewFolder },
    { label: "Rename folder", icon: Pencil, onSelect: m.onRename },
    ...(m.connectedCount > 0
      ? [
          { separator: true } as const,
          {
            label: m.connectedCount === 1 ? "Disconnect 1 connection" : `Disconnect all ${m.connectedCount} connections`,
            icon: Unplug,
            onSelect: m.onDisconnectAll,
          },
        ]
      : []),
    { separator: true },
    {
      label: m.hasConnections ? "Delete folder (move its connections out first)" : "Delete folder",
      icon: Trash2,
      danger: true,
      disabled: m.hasConnections,
      onSelect: m.onDelete,
    },
  ];
}

interface ConnectionMenu {
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function connectionMenuEntries(m: ConnectionMenu): MenuEntry[] {
  return [
    m.connected
      ? { label: "Disconnect", icon: Unplug, onSelect: m.onDisconnect }
      : { label: "Connect", icon: Plug, onSelect: m.onConnect },
    { label: "Edit connection...", icon: Pencil, onSelect: m.onEdit },
    { separator: true },
    { label: "Delete connection...", icon: Trash2, danger: true, onSelect: m.onDelete },
  ];
}

interface DatabaseMenu {
  database: string;
  connectionName: string;
  onOpenConsole: () => void;
  onRunFile: () => void;
  onRefresh: () => void;
}

export function databaseMenuEntries(m: DatabaseMenu): MenuEntry[] {
  return [
    { heading: `${m.database} on ${m.connectionName}` },
    { label: `Open SQL console on ${m.database}`, icon: SquareTerminal, onSelect: m.onOpenConsole },
    { label: "Run SQL file...", icon: FileUp, onSelect: m.onRunFile },
    { label: "Refresh", icon: RefreshCw, onSelect: m.onRefresh },
    { label: "Copy name", icon: Copy, onSelect: () => copyName(m.database) },
  ];
}

interface SchemaMenu {
  schema: string;
  onOpenConsole: () => void;
  onDiagram: () => void;
  onRefresh: () => void;
}

export function schemaMenuEntries(m: SchemaMenu): MenuEntry[] {
  return [
    { heading: m.schema },
    { label: "Open SQL console here", icon: SquareTerminal, onSelect: m.onOpenConsole },
    { label: "Schema diagram", icon: Workflow, onSelect: m.onDiagram },
    { label: "Refresh", icon: RefreshCw, onSelect: m.onRefresh },
    { label: "Copy name", icon: Copy, onSelect: () => copyName(m.schema) },
  ];
}

interface RelationMenu {
  name: string;
  qualified: string;
  isSequence: boolean;
  onOpen: () => void;
  onOpenSql: () => void;
  onStructure: () => void;
  onShowDefinition: () => void;
  /** Tables only: the schema diagram around it. */
  onDiagram?: () => void;
  /** Tables only: load a CSV file into it; disabled on a read-only connection. */
  onImportCsv?: () => void;
  importDisabled?: boolean;
}

export function relationMenuEntries(m: RelationMenu): MenuEntry[] {
  if (m.isSequence) {
    return [
      { heading: m.qualified },
      { label: "Show definition", icon: FileCode, onSelect: m.onShowDefinition },
      { label: "Copy name", icon: Copy, onSelect: () => copyName(m.name) },
      { label: "Copy qualified name", icon: Copy, onSelect: () => copyName(m.qualified) },
    ];
  }
  return [
    { heading: m.qualified },
    { label: "Open data", icon: Table, shortcut: "Enter", onSelect: m.onOpen },
    { label: "Structure", icon: ListTree, onSelect: m.onStructure },
    { label: "Query in SQL", icon: SquareTerminal, onSelect: m.onOpenSql },
    { label: "Show DDL in a console", icon: FileCode, onSelect: m.onShowDefinition },
    ...(m.onDiagram ? [{ label: "Show in schema diagram", icon: Workflow, onSelect: m.onDiagram }] : []),
    ...(m.onImportCsv
      ? [{ label: "Import CSV...", icon: Upload, disabled: m.importDisabled, onSelect: m.onImportCsv }]
      : []),
    { separator: true },
    { label: "Copy name", icon: Copy, onSelect: () => copyName(m.name) },
    { label: "Copy qualified name", icon: Copy, onSelect: () => copyName(m.qualified) },
  ];
}

interface FunctionMenu {
  name: string;
  signature: string;
  onShow: () => void;
}

export function functionMenuEntries(m: FunctionMenu): MenuEntry[] {
  return [
    { heading: m.signature },
    { label: "Show definition", icon: FileCode, onSelect: m.onShow },
    { label: "Copy name", icon: Copy, onSelect: () => copyName(m.name) },
    { label: "Copy signature", icon: Copy, onSelect: () => copyName(m.signature) },
  ];
}

interface TypeMenu {
  name: string;
  onShow: () => void;
}

export function typeMenuEntries(m: TypeMenu): MenuEntry[] {
  return [
    { heading: m.name },
    { label: "Show definition", icon: FileCode, onSelect: m.onShow },
    { label: "Copy name", icon: Copy, onSelect: () => copyName(m.name) },
  ];
}
