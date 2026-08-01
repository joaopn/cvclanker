import { useSyncExternalStore } from "react";

// Mirrored by the inline FOUC script in orchestrator/index.html — keep the
// storage keys, the theme ids AND their order (the script falls back to the
// first entry of each list) in lockstep. theme.test.ts pins both sides.
export const THEME_STORAGE_KEY = "cvclanker:theme";
export const LIGHT_THEME_STORAGE_KEY = "cvclanker:theme-light";
export const DARK_THEME_STORAGE_KEY = "cvclanker:theme-dark";

export type ThemePreference = "system" | "light" | "dark";

type ThemeOption = { id: string; label: string };

// The one home of the selectable palettes. Each id must have a matching
// :root[data-theme="<id>"] block in src/index.css (except the default light
// one, which lives in :root itself) — index.css.test.ts pins that.
//
// The id unions below are DERIVED from these arrays rather than declared
// beside them. A hand-written union constrains only one direction: an array
// member outside it fails, but a union member MISSING from the array
// type-checks, gets no CSS block, and then silently reverts to the default
// when read back.
export const LIGHT_THEMES = [
  { id: "sandstone", label: "Sandstone" },
  { id: "ice", label: "Ice" },
  { id: "newsprint", label: "Newsprint" },
  { id: "vscode-light", label: "VS Code Light" },
  { id: "grape-light", label: "Grape Light" },
] as const satisfies ReadonlyArray<ThemeOption>;

export const DARK_THEMES = [
  { id: "graphite-mono", label: "Graphite Mono" },
  { id: "slate-blue", label: "Slate Blue" },
  { id: "forest-amber", label: "Forest Amber" },
  { id: "nord", label: "Nord" },
  { id: "crimson-noir", label: "Crimson Noir" },
] as const satisfies ReadonlyArray<ThemeOption>;

export type LightThemeId = (typeof LIGHT_THEMES)[number]["id"];
export type DarkThemeId = (typeof DARK_THEMES)[number]["id"];
export type ThemeId = LightThemeId | DarkThemeId;

export const DEFAULT_LIGHT_THEME: LightThemeId = LIGHT_THEMES[0].id;
export const DEFAULT_DARK_THEME: DarkThemeId = DARK_THEMES[0].id;

const listeners = new Set<() => void>();

let attachedSystemQuery: MediaQueryList | null = null;

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the caller still restamps, the choice just does
    // not survive a reload.
  }
}

export function getThemePreference(): ThemePreference {
  const stored = readStored(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function getLightTheme(): LightThemeId {
  const stored = readStored(LIGHT_THEME_STORAGE_KEY);
  return LIGHT_THEMES.some((theme) => theme.id === stored)
    ? (stored as LightThemeId)
    : DEFAULT_LIGHT_THEME;
}

export function getDarkTheme(): DarkThemeId {
  const stored = readStored(DARK_THEME_STORAGE_KEY);
  return DARK_THEMES.some((theme) => theme.id === stored)
    ? (stored as DarkThemeId)
    : DEFAULT_DARK_THEME;
}

export function resolveIsDark(preference: ThemePreference): boolean {
  if (preference === "dark") return true;
  if (preference === "light") return false;
  return systemPrefersDark();
}

export function resolveActiveThemeId(): ThemeId {
  return resolveIsDark(getThemePreference()) ? getDarkTheme() : getLightTheme();
}

// Stamps BOTH hooks, unconditionally and on every branch: the .dark class
// (which drives @custom-variant dark and every dark: utility) and data-theme
// (which selects the palette). A one-sided stamp would leave .dark set against
// the light :root palette — dark-variant styling over light colors.
export function applyThemeClass(): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveIsDark(getThemePreference()));
  root.setAttribute("data-theme", resolveActiveThemeId());
}

export function setThemePreference(preference: ThemePreference): void {
  if (preference === "system") {
    try {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } catch {
      // Storage unavailable — still restamp below; resolution falls back to system.
    }
  } else {
    writeStored(THEME_STORAGE_KEY, preference);
  }
  applyThemeClass();
  notifyListeners();
}

export function setLightTheme(theme: LightThemeId): void {
  writeStored(LIGHT_THEME_STORAGE_KEY, theme);
  applyThemeClass();
  notifyListeners();
}

export function setDarkTheme(theme: DarkThemeId): void {
  writeStored(DARK_THEME_STORAGE_KEY, theme);
  applyThemeClass();
  notifyListeners();
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function handleSystemSchemeChange(): void {
  if (getThemePreference() === "system") {
    applyThemeClass();
  }
  notifyListeners();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    try {
      attachedSystemQuery = window.matchMedia("(prefers-color-scheme: dark)");
      attachedSystemQuery.addEventListener("change", handleSystemSchemeChange);
    } catch {
      attachedSystemQuery = null;
    }
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      attachedSystemQuery?.removeEventListener(
        "change",
        handleSystemSchemeChange,
      );
      attachedSystemQuery = null;
    }
  };
}

export function useTheme(): {
  preference: ThemePreference;
  isDark: boolean;
  activeTheme: ThemeId;
  lightTheme: LightThemeId;
  darkTheme: DarkThemeId;
  setPreference: (preference: ThemePreference) => void;
  setLightTheme: (theme: LightThemeId) => void;
  setDarkTheme: (theme: DarkThemeId) => void;
} {
  // Every subscribed snapshot must be a PRIMITIVE — useSyncExternalStore
  // re-renders forever if getSnapshot returns a fresh object each call.
  const preference = useSyncExternalStore(subscribe, getThemePreference);
  const isDark = useSyncExternalStore(subscribe, () =>
    resolveIsDark(getThemePreference()),
  );
  const activeTheme = useSyncExternalStore(subscribe, resolveActiveThemeId);
  const lightTheme = useSyncExternalStore(subscribe, getLightTheme);
  const darkTheme = useSyncExternalStore(subscribe, getDarkTheme);
  return {
    preference,
    isDark,
    activeTheme,
    lightTheme,
    darkTheme,
    setPreference: setThemePreference,
    setLightTheme,
    setDarkTheme,
  };
}
