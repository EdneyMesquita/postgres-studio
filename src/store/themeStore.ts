import { create } from "zustand";
import { applyTheme, getStoredTheme } from "../lib/themes";
import type { ThemeId } from "../lib/themes";

interface ThemeState {
  themeId: ThemeId;
  setTheme: (themeId: ThemeId) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  themeId: getStoredTheme(),
  setTheme: (themeId) => {
    applyTheme(themeId);
    set({ themeId });
  },
  toggleTheme: () => get().setTheme(get().themeId === "dark" ? "light" : "dark"),
}));
