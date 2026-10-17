import { create } from "zustand";
import { applyTheme, getStoredPreference, resolveTheme, watchSystemTheme } from "../lib/themes";
import type { ThemeId, ThemePreference } from "../lib/themes";

interface ThemeState {
  /** The theme on screen. */
  themeId: ThemeId;
  /** What Settings shows: a theme, or "system". */
  preference: ThemePreference;
  setTheme: (themeId: ThemeId) => void;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  themeId: resolveTheme(getStoredPreference()),
  preference: getStoredPreference(),
  setTheme: (themeId) => get().setPreference(themeId),
  setPreference: (preference) => {
    const themeId = resolveTheme(preference);
    applyTheme(themeId, preference);
    set({ themeId, preference });
  },
  toggleTheme: () => get().setTheme(get().themeId === "dark" ? "light" : "dark"),
}));

// "Match system" follows the system while the app runs.
watchSystemTheme(() => {
  const { preference, setPreference } = useThemeStore.getState();
  if (preference === "system") setPreference("system");
});
