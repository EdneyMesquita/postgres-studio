import { useMemo, type ReactNode } from "react";
import { Folder, Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { Input } from "@/components/ui/input";
import { connectionColor } from "@/lib/connectionColor";
import { connectionIds, reconcile, type FolderNode, type TreeNode } from "@/lib/sidebarTree";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSidebarLayoutStore } from "../../store/sidebarLayoutStore";
import type { ConnectionProfileMeta } from "../../types/connection";

export type CheckState = boolean | "indeterminate";

/**
 * The tree narrowed to `query`. A folder whose name matches keeps all it
 * holds; otherwise a connection stays when its name or address matches.
 */
function narrow(nodes: TreeNode[], query: string, profiles: Map<string, ConnectionProfileMeta>): TreeNode[] {
  return nodes.flatMap((node): TreeNode[] => {
    if (node.type === "connection") {
      const p = profiles.get(node.id);
      const text = `${p?.name ?? ""} ${p?.summary ?? ""}`.toLowerCase();
      return text.includes(query) ? [node] : [];
    }
    if (node.name.toLowerCase().includes(query)) return [node];
    const children = narrow(node.children, query, profiles);
    return children.length > 0 ? [{ ...node, children }] : [];
  });
}

/**
 * Every saved connection in the sidebar's folders (one the sidebar hasn't
 * placed yet included), narrowed to `query`.
 */
export function useConnectionTree(query: string) {
  const profiles = useConnectionsStore((s) => s.profiles);
  const root = useSidebarLayoutStore((s) => s.root);
  const byId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  const tree = useMemo(() => reconcile(root, profiles.map((p) => p.id)), [root, profiles]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? narrow(tree, q, byId) : tree), [tree, q, byId]);
  return { profiles, byId, shown, shownIds: connectionIds(shown), filtered: q.length > 0 };
}

/** The tri-state of a group: none, some or all of `ids` on. */
export function groupState(ids: string[], isOn: (id: string) => boolean): CheckState {
  const on = ids.filter(isOn).length;
  return on === 0 ? false : on === ids.length ? true : "indeterminate";
}

interface ConnectionTreeProps {
  nodes: TreeNode[];
  byId: Map<string, ConnectionProfileMeta>;
  /** The control at the start of a folder's row, for everything in it. */
  folderControl: (folder: FolderNode, ids: string[]) => ReactNode;
  /** Faint text at the end of a folder's row, e.g. "2 of 3". */
  folderTrailing?: (folder: FolderNode, ids: string[]) => ReactNode;
  /** The control at the start of a connection's row. */
  connectionControl?: (profile: ConnectionProfileMeta) => ReactNode;
  /** What ends a connection's row: a note or a control. */
  connectionTrailing?: (profile: ConnectionProfileMeta) => ReactNode;
  /** Rows are labels, so clicking anywhere on one works its checkbox. */
  rowsAreLabels?: boolean;
  "aria-label": string;
}

/**
 * Saved connections laid out in the sidebar's folders, one row each, with
 * a control per folder and per connection - the picker the Assistant's
 * access, the export and the MCP server's access share.
 */
export function ConnectionTree({
  nodes,
  byId,
  folderControl,
  folderTrailing,
  connectionControl,
  connectionTrailing,
  rowsAreLabels = true,
  ...aria
}: ConnectionTreeProps) {
  const Row = rowsAreLabels ? "label" : "div";
  const rowClass = "flex h-8 items-center gap-2 rounded-sm pr-2 hover:bg-hover" + (rowsAreLabels ? " cursor-pointer" : "");

  function renderNodes(list: TreeNode[], depth: number): ReactNode {
    return list.map((node) => {
      const indent = { paddingLeft: 8 + depth * 20 };
      if (node.type === "folder") {
        const ids = connectionIds(node.children);
        if (ids.length === 0) return null;
        return (
          <li key={node.id}>
            <Row style={indent} className={rowClass}>
              {folderControl(node, ids)}
              <Folder className="size-3.5 shrink-0 text-fg-3" />
              <span className="min-w-0 truncate font-medium">{node.name}</span>
              <span className="ml-auto flex shrink-0 items-center text-xs tabular-nums text-fg-3">
                {folderTrailing?.(node, ids)}
              </span>
            </Row>
            <ul>{renderNodes(node.children, depth + 1)}</ul>
          </li>
        );
      }
      const p = byId.get(node.id);
      if (!p) return null;
      return (
        <li key={node.id}>
          <Row style={indent} className={rowClass}>
            {connectionControl?.(p)}
            <ConnectionChip name={p.name} color={connectionColor(p.id, p.color)} size="sm" />
            <span className="max-w-[45%] shrink-0 truncate">{p.name}</span>
            <span className="min-w-0 flex-1 truncate font-data text-fg-3" title={p.summary}>
              {p.summary}
            </span>
            {connectionTrailing && <span className="flex shrink-0 items-center">{connectionTrailing(p)}</span>}
          </Row>
        </li>
      );
    });
  }

  return (
    <ul role="group" aria-label={aria["aria-label"]}>
      {renderNodes(nodes, 0)}
    </ul>
  );
}

interface CheckboxConnectionTreeProps {
  nodes: TreeNode[];
  byId: Map<string, ConnectionProfileMeta>;
  isChecked: (id: string) => boolean;
  setChecked: (ids: string[], on: boolean) => void;
  connectionTrailing?: (profile: ConnectionProfileMeta) => ReactNode;
  "aria-label": string;
}

/** The tree with a checkbox per connection and one per folder ticking all it holds. */
export function CheckboxConnectionTree({ isChecked, setChecked, ...rest }: CheckboxConnectionTreeProps) {
  // Ticking a partly ticked group ticks all of it.
  const toggle = (ids: string[]) => setChecked(ids, groupState(ids, isChecked) !== true);
  return (
    <ConnectionTree
      {...rest}
      folderControl={(folder, ids) => (
        <Checkbox checked={groupState(ids, isChecked)} onCheckedChange={() => toggle(ids)} aria-label={`All in ${folder.name}`} />
      )}
      folderTrailing={(_, ids) => `${ids.filter(isChecked).length} of ${ids.length}`}
      connectionControl={(p) => <Checkbox checked={isChecked(p.id)} onCheckedChange={(on) => setChecked([p.id], on === true)} />}
    />
  );
}

interface ConnectionPickerHeaderProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Omit for a picker without "Select all" (e.g. levels instead of checkboxes). */
  selectAll?: { state: CheckState; disabled: boolean; onToggle: () => void; filtered: boolean };
  /** e.g. "3 of 6 allowed" */
  count: ReactNode;
  autoFocus?: boolean;
}

/** The filter over a connection tree, and "Select all" with a count. */
export function ConnectionPickerHeader({ query, onQueryChange, selectAll, count, autoFocus }: ConnectionPickerHeaderProps) {
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
        <Input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter by name, address or folder"
          aria-label="Filter connections"
          className="pl-8"
        />
      </div>
      <div className="flex h-6 items-center gap-2 text-sm text-fg-2">
        {selectAll && (
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox checked={selectAll.state} disabled={selectAll.disabled} onCheckedChange={selectAll.onToggle} />
            {selectAll.filtered ? "Select all shown" : "Select all"}
          </label>
        )}
        <span className="ml-auto tabular-nums">{count}</span>
      </div>
    </div>
  );
}

/** What a picker shows when the filter hides everything, or there's nothing. */
export function ConnectionTreeEmpty({ hasProfiles, query }: { hasProfiles: boolean; query: string }) {
  return (
    <p className="m-0 px-2 py-6 text-center text-sm text-fg-3">
      {hasProfiles ? `Nothing matches "${query.trim()}".` : "No saved connections yet."}
    </p>
  );
}
