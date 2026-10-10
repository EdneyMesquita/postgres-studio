import { Activity, Copy, DatabaseBackup, DatabaseZap, FileCode, FileUp, FolderPlus, ListTree, Pencil, Plug, Puzzle, RefreshCw, SquareTerminal, Table, Trash2, Unplug, Upload, Users, Workflow, Wrench } from "lucide-react";
import { toast } from "sonner";
import type { MenuEntry } from "@/components/common/ActionMenu";
import { GENERATE_LABEL, MAINTENANCE_LABEL, generatableFor, maintenanceFor } from "@/lib/tableActions";
import type { GenerateKind } from "@/lib/tableActions";
import type { MaintenanceAction } from "../../types/objects";
import type { RelKind } from "../../types/pg";

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
  /** The server's roles; offered while connected. */
  onRoles?: () => void;
}

export function connectionMenuEntries(m: ConnectionMenu): MenuEntry[] {
  return [
    m.connected
      ? { label: "Disconnect", icon: Unplug, onSelect: m.onDisconnect }
      : { label: "Connect", icon: Plug, onSelect: m.onConnect },
    ...(m.connected && m.onRoles ? [{ label: "Roles…", icon: Users, onSelect: m.onRoles }] : []),
    { label: "Edit connection...", icon: Pencil, onSelect: m.onEdit },
    { separator: true },
    { label: "Delete connection...", icon: Trash2, danger: true, onSelect: m.onDelete },
  ];
}

interface DatabaseMenu {
  database: string;
  connectionName: string;
  onOpenConsole: () => void;
  onActivity: () => void;
  onExtensions: () => void;
  onRunFile: () => void;
  onRefresh: () => void;
  onBackup: () => void;
  onRestore: () => void;
}

export function databaseMenuEntries(m: DatabaseMenu): MenuEntry[] {
  return [
    { heading: `${m.database} on ${m.connectionName}` },
    { label: `Open SQL console on ${m.database}`, icon: SquareTerminal, onSelect: m.onOpenConsole },
    { label: "Server activity", icon: Activity, onSelect: m.onActivity },
    { label: "Manage extensions…", icon: Puzzle, onSelect: m.onExtensions },
    { label: "Run SQL file...", icon: FileUp, onSelect: m.onRunFile },
    { label: "Refresh", icon: RefreshCw, onSelect: m.onRefresh },
    { separator: true },
    { label: "Back up with pg_dump...", icon: DatabaseBackup, onSelect: m.onBackup },
    { label: "Restore from a backup...", icon: DatabaseZap, onSelect: m.onRestore },
    { separator: true },
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
  kind?: RelKind;
  /** TRUNCATE can't run on a read-only connection. */
  readOnly?: boolean;
  onMaintenance?: (action: MaintenanceAction) => void;
  onGenerate?: (kind: GenerateKind) => void;
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
    ...tableToolsEntries(m),
    ...(m.onImportCsv
      ? [{ label: "Import CSV...", icon: Upload, disabled: m.importDisabled, onSelect: m.onImportCsv }]
      : []),
    { separator: true },
    { label: "Copy name", icon: Copy, onSelect: () => copyName(m.name) },
    { label: "Copy qualified name", icon: Copy, onSelect: () => copyName(m.qualified) },
  ];
}

/** The Maintenance and Generate SQL submenus, for what the relation's kind allows. */
function tableToolsEntries(m: RelationMenu): MenuEntry[] {
  if (!m.kind) return [];
  const maintenance = m.onMaintenance ? maintenanceFor(m.kind) : [];
  const generate = m.onGenerate ? generatableFor(m.kind) : [];
  const entries: MenuEntry[] = [];
  if (maintenance.length > 0 || generate.length > 0) entries.push({ separator: true });
  if (maintenance.length > 0) {
    entries.push({
      submenu: "Maintenance",
      icon: Wrench,
      entries: maintenance.map((action) => ({
        label: MAINTENANCE_LABEL[action],
        danger: action === "truncate",
        disabled: action === "truncate" && m.readOnly,
        onSelect: () => m.onMaintenance?.(action),
      })),
    });
  }
  if (generate.length > 0) {
    entries.push({
      submenu: "Generate SQL",
      icon: FileCode,
      entries: generate.map((kind) => ({ label: GENERATE_LABEL[kind], onSelect: () => m.onGenerate?.(kind) })),
    });
  }
  return entries;
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

interface GraphMenu {
  graph: string;
  onNewQuery: () => void;
}

export function graphMenuEntries(m: GraphMenu): MenuEntry[] {
  return [
    { heading: m.graph },
    { label: "New Cypher query", icon: SquareTerminal, onSelect: m.onNewQuery },
    { label: "Copy name", icon: Copy, onSelect: () => copyName(m.graph) },
  ];
}

interface GraphLabelMenu {
  graph: string;
  label: string;
  /** `v` for a vertex label, `e` for an edge label. */
  kind: "v" | "e";
  onMatch: () => void;
}

export function graphLabelMenuEntries(m: GraphLabelMenu): MenuEntry[] {
  return [
    { heading: `${m.graph}:${m.label}` },
    { label: m.kind === "v" ? "Match nodes" : "Match edges", icon: SquareTerminal, onSelect: m.onMatch },
    { label: "Copy name", icon: Copy, onSelect: () => copyName(m.label) },
  ];
}

interface PropertyGraphMenu {
  qualified: string;
  onQuery: () => void;
}

export function propertyGraphMenuEntries(m: PropertyGraphMenu): MenuEntry[] {
  return [
    { heading: m.qualified },
    { label: "Query with GRAPH_TABLE", icon: SquareTerminal, onSelect: m.onQuery },
    { label: "Copy qualified name", icon: Copy, onSelect: () => copyName(m.qualified) },
  ];
}
