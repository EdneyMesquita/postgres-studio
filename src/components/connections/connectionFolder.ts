import { useMemo } from "react";
import { findFolder, locate, type TreeNode } from "@/lib/sidebarTree";
import { useSidebarLayoutStore } from "@/store/sidebarLayoutStore";

export interface FolderOption {
  id: string;
  /** Nested folders read "Parent / Child". */
  label: string;
}

function folderOptions(nodes: TreeNode[], prefix = ""): FolderOption[] {
  return nodes.flatMap((node) => {
    if (node.type !== "folder") return [];
    const label = prefix + node.name;
    return [{ id: node.id, label }, ...folderOptions(node.children, `${label} / `)];
  });
}

/** Every sidebar folder, in tree order. */
export function useFolderOptions(): FolderOption[] {
  const root = useSidebarLayoutStore((s) => s.root);
  return useMemo(() => folderOptions(root), [root]);
}

/** The folder a connection sits in; null at the root or when not placed. */
export function folderOf(connectionId: string): string | null {
  return locate(useSidebarLayoutStore.getState().root, connectionId)?.parentId ?? null;
}

/**
 * Moves a saved connection to the end of `folderId` (null: the root) unless
 * it's already there. `connectionIds` are all saved ones, so a connection
 * saved a moment ago joins the tree before it moves.
 */
export function placeInFolder(connectionId: string, folderId: string | null, connectionIds: string[]) {
  const layout = useSidebarLayoutStore.getState();
  if (!layout.loaded) return;
  layout.sync(connectionIds);
  const root = useSidebarLayoutStore.getState().root;
  const where = locate(root, connectionId);
  if (!where || where.parentId === folderId) return;
  const siblings = folderId === null ? root : findFolder(root, folderId)?.children;
  if (!siblings) return; // the folder was deleted meanwhile
  layout.move(connectionId, { parentId: folderId, index: siblings.length });
}
