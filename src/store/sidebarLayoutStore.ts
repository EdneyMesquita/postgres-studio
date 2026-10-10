import { create } from "zustand";
import { api } from "../lib/tauri";
import {
  canMove,
  containsConnections,
  findFolder,
  insertNode,
  moveNode,
  parseLayout,
  reconcile,
  removeNode,
  updateFolder,
} from "../lib/sidebarTree";
import type { DropTarget, SidebarLayout, TreeNode } from "../lib/sidebarTree";

interface SidebarLayoutState {
  root: TreeNode[];
  loaded: boolean;
  /** The folder whose name is being edited inline. */
  renamingId: string | null;
  error: string | null;

  load: () => Promise<void>;
  /** Reconciles with the saved connections; call once they're known. */
  sync: (connectionIds: string[]) => void;
  createFolder: (parentId: string | null) => void;
  startRename: (id: string | null) => void;
  renameFolder: (id: string, name: string) => void;
  /** Removes an empty folder; refuses one holding connections. */
  deleteFolder: (id: string) => void;
  toggleFolder: (id: string) => void;
  move: (id: string, target: DropTarget) => void;
}

let loading: Promise<void> | null = null;

export const useSidebarLayoutStore = create<SidebarLayoutState>((set, get) => {
  /** Applies a new tree and writes it to disk. */
  function commit(root: TreeNode[]) {
    set({ root });
    const layout: SidebarLayout = { version: 1, root };
    api.saveSidebarLayout(layout).then(
      () => set({ error: null }),
      (e) => set({ error: `Couldn't save the sidebar layout: ${String(e)}` }),
    );
  }

  return {
    root: [],
    loaded: false,
    renamingId: null,
    error: null,

    // Only the first call reads the file. A second one (StrictMode mounts the
    // sidebar twice) could otherwise finish after the tree was already
    // reconciled and saved, and put back the stale, emptier copy it read.
    load: () =>
      (loading ??= (async () => {
        try {
          set({ root: parseLayout(await api.getSidebarLayout()), loaded: true, error: null });
        } catch (e) {
          // Still usable - flat, like before folders existed.
          set({ loaded: true, error: `Couldn't load the sidebar layout: ${String(e)}` });
        }
      })()),

    sync: (connectionIds) => {
      if (!get().loaded) return;
      const next = reconcile(get().root, connectionIds);
      if (JSON.stringify(next) !== JSON.stringify(get().root)) commit(next);
    },

    createFolder: (parentId) => {
      const id = crypto.randomUUID();
      let root = insertNode(get().root, { parentId, index: 0 }, {
        type: "folder",
        id,
        name: "New folder",
        children: [],
      });
      // show it: a new folder inside a collapsed one would be invisible
      if (parentId) root = updateFolder(root, parentId, { collapsed: false });
      commit(root);
      set({ renamingId: id });
    },

    startRename: (id) => set({ renamingId: id }),

    renameFolder: (id, name) => {
      set({ renamingId: null });
      const trimmed = name.trim();
      if (trimmed && findFolder(get().root, id)?.name !== trimmed) {
        commit(updateFolder(get().root, id, { name: trimmed }));
      }
    },

    deleteFolder: (id) => {
      const folder = findFolder(get().root, id);
      if (!folder || containsConnections(folder)) return;
      commit(removeNode(get().root, id));
    },

    toggleFolder: (id) => {
      const folder = findFolder(get().root, id);
      if (folder) commit(updateFolder(get().root, id, { collapsed: !folder.collapsed }));
    },

    move: (id, target) => {
      if (!canMove(get().root, id, target)) return;
      let root = moveNode(get().root, id, target);
      // dropping into a collapsed folder opens it, so the move is visible
      if (target.parentId) root = updateFolder(root, target.parentId, { collapsed: false });
      commit(root);
    },
  };
});
