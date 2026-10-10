import { useMemo, useState } from "react";
import { Folder, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConnectionChip } from "@/components/ui/ConnectionChip";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { connectionColor } from "@/lib/connectionColor";
import { connectionIds, reconcile, type TreeNode } from "@/lib/sidebarTree";
import { defaultAccess, useAssistantStore } from "../../store/assistantStore";
import { useConnectionsStore } from "../../store/connectionsStore";
import { useSidebarLayoutStore } from "../../store/sidebarLayoutStore";
import type { ConnectionProfileMeta } from "../../types/connection";

type CheckState = boolean | "indeterminate";

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
 * Picks the connections the Assistant may read, laid out in the sidebar's
 * folders: a box per folder ticks everything in it, one at the top ticks
 * everything shown, and the filter narrows by name, address or folder.
 * Changes apply as they're made.
 */
export function AssistantAccessDialog({ onClose }: { onClose: () => void }) {
  const profiles = useConnectionsStore((s) => s.profiles);
  const root = useSidebarLayoutStore((s) => s.root);
  const access = useAssistantStore((s) => s.access);
  const setAccess = useAssistantStore((s) => s.setAccess);
  const [query, setQuery] = useState("");

  const byId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);
  // Every saved connection, even one the sidebar hasn't placed yet.
  const tree = useMemo(() => reconcile(root, profiles.map((p) => p.id)), [root, profiles]);
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? narrow(tree, q, byId) : tree), [tree, q, byId]);

  const allowed = (id: string) => access[id] ?? defaultAccess(byId.get(id)?.summary);
  const stateOf = (ids: string[]): CheckState => {
    const on = ids.filter(allowed).length;
    return on === 0 ? false : on === ids.length ? true : "indeterminate";
  };
  // Ticking a partly ticked group allows all of it.
  const toggle = (ids: string[]) => setAccess(ids, stateOf(ids) !== true);

  const shownIds = connectionIds(shown);
  const allowedCount = profiles.filter((p) => allowed(p.id)).length;

  function renderNodes(nodes: TreeNode[], depth: number) {
    return nodes.map((node) => {
      const indent = { paddingLeft: 8 + depth * 20 };
      if (node.type === "folder") {
        const ids = connectionIds(node.children);
        if (ids.length === 0) return null;
        const state = stateOf(ids);
        return (
          <li key={node.id}>
            <label style={indent} className="flex h-8 cursor-pointer items-center gap-2 rounded-sm pr-2 hover:bg-hover">
              <Checkbox checked={state} onCheckedChange={() => toggle(ids)} aria-label={`All in ${node.name}`} />
              <Folder className="size-3.5 shrink-0 text-fg-3" />
              <span className="min-w-0 truncate font-medium">{node.name}</span>
              <span className="ml-auto shrink-0 text-xs tabular-nums text-fg-3">
                {ids.filter(allowed).length} of {ids.length}
              </span>
            </label>
            <ul>{renderNodes(node.children, depth + 1)}</ul>
          </li>
        );
      }
      const p = byId.get(node.id);
      if (!p) return null;
      return (
        <li key={node.id}>
          <label style={indent} className="flex h-8 cursor-pointer items-center gap-2 rounded-sm pr-2 hover:bg-hover">
            <Checkbox checked={allowed(p.id)} onCheckedChange={(on) => setAccess([p.id], on === true)} />
            <ConnectionChip name={p.name} color={connectionColor(p.id, p.color)} size="sm" />
            <span className="shrink-0 truncate max-w-[45%]">{p.name}</span>
            <span className="min-w-0 flex-1 truncate font-data text-fg-3" title={p.summary}>
              {p.summary}
            </span>
            {defaultAccess(p.summary) && <span className="shrink-0 text-xs text-fg-3">This computer</span>}
          </label>
        </li>
      );
    });
  }

  return (
    <Modal
      title="Connections the Assistant may read"
      onClose={onClose}
      width="max-w-2xl"
      bodyClassName="px-2.5 py-2"
      subheader={
        <div className="flex flex-col gap-2 px-[18px] py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-3" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, address or folder"
              aria-label="Filter connections"
              className="pl-8"
            />
          </div>
          <div className="flex h-6 items-center gap-2 text-sm text-fg-2">
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={shownIds.length === 0 ? false : stateOf(shownIds)}
                disabled={shownIds.length === 0}
                onCheckedChange={() => toggle(shownIds)}
              />
              {q ? "Select all shown" : "Select all"}
            </label>
            <span className="ml-auto tabular-nums">
              {allowedCount} of {profiles.length} allowed
            </span>
          </div>
        </div>
      }
      footer={
        <>
          <p className="m-0 flex-1 text-xs leading-normal text-fg-3">
            Connection strings and passwords never reach the agent.
          </p>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {shown.length === 0 ? (
        <p className="m-0 px-2 py-6 text-center text-sm text-fg-3">
          {profiles.length === 0 ? "No saved connections yet." : `Nothing matches "${query.trim()}".`}
        </p>
      ) : (
        <ul role="group" aria-label="Connections the Assistant may read">
          {renderNodes(shown, 0)}
        </ul>
      )}
    </Modal>
  );
}
