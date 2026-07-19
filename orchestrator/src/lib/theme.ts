import { useSyncExternalStore } from "react";

// Mirrored by the inline FOUC script in orchestrator/index.html — keep the
// storage key and the resolution semantics (absent/unknown = system) in lockstep.
export const THEME_STORAGE_KEY = "cvclanker:theme";

export type ThemePreference = "system" | "light" | "dark";

const listeners = new Set<() => void>();

let attachedSystemQuery: MediaQueryList | null = null;

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function getThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveIsDark(preference: ThemePreference): boolean {
  if (preference === "dark") return true;
  if (preference === "light") return false;
  return systemPrefersDark();
}

export function applyThemeClass(): void {
  document.documentElement.classList.toggle(
    "dark",
    resolveIsDark(getThemePreference()),
  );
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Storage unavailable — still restamp below; resolution falls back to system.
  }
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
  setPreference: (preference: ThemePreference) => void;
} {
  const preference = useSyncExternalStore(subscribe, getThemePreference);
  const isDark = useSyncExternalStore(subscribe, () =>
    resolveIsDark(getThemePreference()),
  );
  return { preference, isDark, setPreference: setThemePreference };
}
