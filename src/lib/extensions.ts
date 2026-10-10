import type { AvailableExtension } from "../types/objects";

export type ExtensionState = "available" | "installed" | "update";
export type ExtensionFilter = "all" | "installed" | "update";

/** Not installed, installed at the default version, or installed with a newer default on offer. */
export function extensionState(e: AvailableExtension): ExtensionState {
  if (e.installedVersion === null) return "available";
  return e.defaultVersion !== null && e.defaultVersion !== e.installedVersion ? "update" : "installed";
}

/** The extensions matching a search (name or description) and a filter, in name order. */
export function filterExtensions(list: AvailableExtension[], query: string, filter: ExtensionFilter): AvailableExtension[] {
  const q = query.trim().toLowerCase();
  return list
    .filter((e) => {
      if (filter === "installed" && e.installedVersion === null) return false;
      if (filter === "update" && extensionState(e) !== "update") return false;
      return q === "" || e.name.toLowerCase().includes(q) || (e.comment ?? "").toLowerCase().includes(q);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
