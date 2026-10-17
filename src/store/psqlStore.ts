import { create } from "zustand";
import { api } from "../lib/tauri";
import type { PsqlInfo } from "../types/pg";
import { useSettingsStore } from "./settingsStore";

interface PsqlState {
  /** What the last look found; null before the first. */
  info: PsqlInfo | null;
  detecting: boolean;
  /** Looks for psql again: the picked executable, else the PATH and the usual installs. */
  detect: () => Promise<PsqlInfo | null>;
}

export const usePsqlStore = create<PsqlState>((set) => ({
  info: null,
  detecting: false,

  detect: async () => {
    set({ detecting: true });
    try {
      const info = await api.psqlDetect(useSettingsStore.getState().psql.path);
      set({ info });
      return info;
    } catch (e) {
      set({ info: { path: null, version: null, custom: false, error: String(e), searched: [] } });
      return null;
    } finally {
      set({ detecting: false });
    }
  },
}));

/** Whether psql was found and runs. */
export function psqlFound(info: PsqlInfo | null): boolean {
  return Boolean(info?.path) && !info?.error;
}
