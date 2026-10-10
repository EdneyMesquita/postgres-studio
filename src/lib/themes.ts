export type ThemeId = "dark" | "light";

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

/** The saved theme: "light", or dark for anything else. */
export function getStoredTheme(): ThemeId {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(themeId: ThemeId) {
  document.documentElement.dataset.theme = themeId;
  try {
    localStorage.setItem(STORAGE_KEY, themeId);
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
