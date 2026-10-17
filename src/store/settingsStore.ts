import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Choices for the rows a new table tab asks for. */
export const PAGE_SIZES = [50, 100, 200, 500, 1000] as const;

/** Choices for the rows a console keeps of each result. */
export const CONSOLE_ROW_LIMITS = [500, 1000, 5000, 10000] as const;

interface SettingsState {
  /** The limit a new table tab starts with. */
  pageSize: number;
  setPageSize: (size: number) => void;
  /** How many rows of each result a console keeps; a result with more says so. */
  consoleRowLimit: number;
  setConsoleRowLimit: (limit: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      pageSize: 100,
      setPageSize: (pageSize) => set({ pageSize }),
      consoleRowLimit: 1000,
      setConsoleRowLimit: (consoleRowLimit) => set({ consoleRowLimit }),
    }),
    {
      name: "postgres-studio-settings",
      version: 1,
      partialize: (s) => ({
        pageSize: s.pageSize,
        consoleRowLimit: s.consoleRowLimit,
      }),
    },
  ),
);
