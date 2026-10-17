export type ThemeId = "dark" | "light";

/** What the user picked: a theme, or whatever the system uses. */
export type ThemePreference = ThemeId | "system";

export interface ThemeOption {
  id: ThemeId;
  name: string;
}

/** One identity in a dark and a light version (DESIGN.md: Twin Themes). */
export const THEMES: ThemeOption[] = [
  { id: "dark", name: "Dark" },
  { id: "light", name: "Light" },
];

const STORAGE_KEY = "postgres-studio-theme";
const DEFAULT_THEME: ThemeId = "dark";

/** The saved preference: "light", "system", or dark for anything else. */
export function getStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "system" ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

const systemQuery = () => window.matchMedia?.("(prefers-color-scheme: light)");

/** The theme a preference shows right now. */
export function resolveTheme(preference: ThemePreference): ThemeId {
  if (preference !== "system") return preference;
  return systemQuery()?.matches ? "light" : "dark";
}

/** The saved theme, as shown now. */
export function getStoredTheme(): ThemeId {
  return resolveTheme(getStoredPreference());
}

/** Calls `onChange` when the system switches between light and dark. */
export function watchSystemTheme(onChange: () => void): () => void {
  const query = systemQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

/** Shows `themeId` and saves `preference` (the theme itself by default). */
export function applyTheme(themeId: ThemeId, preference: ThemePreference = themeId) {
  document.documentElement.dataset.theme = themeId;
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // localStorage unavailable (private mode, etc.) - theme just won't persist
  }
}

export function isLightTheme(themeId: ThemeId): boolean {
  return themeId === "light";
}

/** The Monaco theme registered for an app theme (see lib/monaco.ts). */
export function monacoTheme(themeId: ThemeId): string {
  return themeId === "light" ? "postgres-studio-light" : "postgres-studio-dark";
}
