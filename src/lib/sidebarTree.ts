/**
 * The sidebar's connection tree: folders, possibly nested, holding
 * connections in the order the user arranged them. Pure and immutable -
 * every operation returns a new tree.
 */

export interface FolderNode {
  type: "folder";
  id: string;
  name: string;
  collapsed?: boolean;
  children: TreeNode[];
}

export interface ConnectionNode {
  type: "connection";
  id: string;
}

export type TreeNode = FolderNode | ConnectionNode;

/** Where a node goes: a position among a folder's children, or the root's. */
export interface DropTarget {
  parentId: string | null;
  index: number;
}

export interface SidebarLayout {
  version: 1;
  root: TreeNode[];
}

/** Reads a stored layout, or an empty tree when it's missing or malformed. */
export function parseLayout(value: unknown): TreeNode[] {
  if (typeof value !== "object" || value === null) return [];
  const root = (value as { root?: unknown }).root;
  return Array.isArray(root) ? root.filter(isNode).map(cleanNode) : [];
}

function isNode(value: unknown): value is TreeNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as { type?: unknown; id?: unknown; name?: unknown; children?: unknown };
  if (typeof node.id !== "string") return false;
  if (node.type === "connection") return true;
  return node.type === "folder" && typeof node.name === "string" && Array.isArray(node.children);
}

function cleanNode(node: TreeNode): TreeNode {
  if (node.type === "connection") return { type: "connection", id: node.id };
  return {
    type: "folder",
    id: node.id,
    name: node.name,
    collapsed: node.collapsed === true || undefined,
    children: node.children.filter(isNode).map(cleanNode),
  };
}

export function findFolder(root: TreeNode[], id: string): FolderNode | null {
  for (const node of root) {
    if (node.type !== "folder") continue;
    if (node.id === id) return node;
    const inner = findFolder(node.children, id);
    if (inner) return inner;
  }
  return null;
}

/** Whether a folder holds any connection, however deep. */
/** The connections under these nodes, at any depth, in tree order. */
export function connectionIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.type === "connection" ? [n.id] : connectionIds(n.children)));
}

export function containsConnections(folder: FolderNode): boolean {
  return folder.children.some((c) => c.type === "connection" || containsConnections(c));
}

/** Applies `fn` to the children list `parentId` names (null: the root). */
function updateChildren(
  root: TreeNode[],
  parentId: string | null,
  fn: (children: TreeNode[]) => TreeNode[],
): TreeNode[] {
  if (parentId === null) return fn(root);
  return root.map((node) =>
    node.type !== "folder"
      ? node
      : node.id === parentId
        ? { ...node, children: fn(node.children) }
        : { ...node, children: updateChildren(node.children, parentId, fn) },
  );
}

/** The node and where it sits, or null. */
export function locate(
  root: TreeNode[],
  id: string,
  parentId: string | null = null,
): { node: TreeNode; parentId: string | null; index: number } | null {
  for (let i = 0; i < root.length; i++) {
    const node = root[i];
    if (node.id === id) return { node, parentId, index: i };
    if (node.type === "folder") {
      const inner = locate(node.children, id, node.id);
      if (inner) return inner;
    }
  }
  return null;
}

export function insertNode(root: TreeNode[], target: DropTarget, node: TreeNode): TreeNode[] {
  return updateChildren(root, target.parentId, (children) => {
    const next = [...children];
    next.splice(Math.max(0, Math.min(target.index, next.length)), 0, node);
    return next;
  });
}

export function removeNode(root: TreeNode[], id: string): TreeNode[] {
  return root
    .filter((node) => node.id !== id)
    .map((node) =>
      node.type === "folder" ? { ...node, children: removeNode(node.children, id) } : node,
    );
}

/** Whether `target` is somewhere inside the folder `ancestorId`, or is it. */
function isWithin(root: TreeNode[], ancestorId: string, target: string | null): boolean {
  if (target === null) return false;
  if (target === ancestorId) return true;
  const ancestor = findFolder(root, ancestorId);
  return ancestor !== null && findFolder(ancestor.children, target) !== null;
}

/** Whether moving `id` to `target` is allowed: never into itself. */
export function canMove(root: TreeNode[], id: string, target: DropTarget): boolean {
  const found = locate(root, id);
  if (!found) return false;
  return found.node.type !== "folder" || !isWithin(root, id, target.parentId);
}

/**
 * Moves a node. `target.index` is a position in the destination as it looks
 * before the move, so dropping below yourself in the same list lands where
 * the pointer was.
 */
export function moveNode(root: TreeNode[], id: string, target: DropTarget): TreeNode[] {
  const found = locate(root, id);
  if (!found || !canMove(root, id, target)) return root;
  let index = target.index;
  if (found.parentId === target.parentId && found.index < index) index -= 1;
  return insertNode(removeNode(root, id), { parentId: target.parentId, index }, found.node);
}

export function updateFolder(
  root: TreeNode[],
  id: string,
  patch: Partial<Pick<FolderNode, "name" | "collapsed">>,
): TreeNode[] {
  return root.map((node) =>
    node.type !== "folder"
      ? node
      : node.id === id
        ? { ...node, ...patch }
        : { ...node, children: updateFolder(node.children, id, patch) },
  );
}

/**
 * Brings the tree in line with the saved connections: drops ones that were
 * deleted and appends new ones at the end of the root.
 */
export function reconcile(root: TreeNode[], connectionIds: string[]): TreeNode[] {
  const known = new Set(connectionIds);
  const seen = new Set<string>();
  function prune(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .filter((n) => n.type === "folder" || (known.has(n.id) && !seen.has(n.id) && seen.add(n.id)))
      .map((n) => (n.type === "folder" ? { ...n, children: prune(n.children) } : n));
  }
  const pruned = prune(root);
  const missing = connectionIds.filter((id) => !seen.has(id));
  return missing.length === 0
    ? pruned
    : [...pruned, ...missing.map((id): TreeNode => ({ type: "connection", id }))];
}

/**
 * The tree narrowed to connections matching `matches`, keeping the folders
 * on their path - so a search still shows where each hit lives.
 */
export function filterTree(root: TreeNode[], matches: (connectionId: string) => boolean): TreeNode[] {
  return root.flatMap((node): TreeNode[] => {
    if (node.type === "connection") return matches(node.id) ? [node] : [];
    const children = filterTree(node.children, matches);
    return children.length > 0 ? [{ ...node, children }] : [];
  });
}
