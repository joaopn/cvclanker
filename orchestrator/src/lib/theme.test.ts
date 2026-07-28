import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeClass,
  DARK_THEME_STORAGE_KEY,
  DARK_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  getDarkTheme,
  getLightTheme,
  getThemePreference,
  LIGHT_THEME_STORAGE_KEY,
  LIGHT_THEMES,
  resolveActiveThemeId,
  resolveIsDark,
  setDarkTheme,
  setLightTheme,
  setThemePreference,
  THEME_STORAGE_KEY,
  useTheme,
} from "./theme";

function stubMatchMedia(initialMatches: boolean) {
  const changeListeners = new Set<() => void>();
  const mediaQueryList = {
    matches: initialMatches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, listener: () => void) => {
      changeListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      changeListeners.delete(listener);
    },
  };
  vi.stubGlobal("matchMedia", () => mediaQueryList);
  return {
    changeListeners,
    setMatches: (next: boolean) => {
      mediaQueryList.matches = next;
      for (const listener of [...changeListeners]) {
        listener();
      }
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-theme");
});

describe("theme preference store", () => {
  it("defaults to system when nothing is stored and treats unknown values as system", () => {
    expect(getThemePreference()).toBe("system");
    window.localStorage.setItem(THEME_STORAGE_KEY, "banana");
    expect(getThemePreference()).toBe("system");
  });

  it("resolveIsDark honors explicit preferences and asks matchMedia for system", () => {
    stubMatchMedia(true);
    expect(resolveIsDark("dark")).toBe(true);
    expect(resolveIsDark("light")).toBe(false);
    expect(resolveIsDark("system")).toBe(true);
  });

  it("resolves system to light when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveIsDark("system")).toBe(false);
  });

  it("setThemePreference persists light/dark, clears the key for system, and stamps the class", () => {
    stubMatchMedia(true);

    setThemePreference("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    setThemePreference("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    setThemePreference("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("applyThemeClass stamps from the stored preference", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    applyThemeClass();
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    applyThemeClass();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("useTheme consumers see setPreference updates", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.preference).toBe("system");
    expect(result.current.isDark).toBe(false);

    act(() => {
      result.current.setPreference("dark");
    });
    expect(result.current.preference).toBe("dark");
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("useTheme follows OS scheme changes while on system and re-stamps the class", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(false);

    act(() => {
      media.setMatches(true);
    });
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("detaches the system listener when the last consumer unmounts", () => {
    const media = stubMatchMedia(false);
    const { unmount } = renderHook(() => useTheme());
    expect(media.changeListeners.size).toBe(1);
    unmount();
    expect(media.changeListeners.size).toBe(0);
  });

  it("the index.html FOUC script mirrors the storage keys and resolution literals", () => {
    // In the tools image this reads the BAKED index.html (only src/ is
    // bind-mounted), so it hard-pins the theme.ts side of the lockstep; an
    // html-side-only edit needs an image rebuild to be seen here.
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(html).toContain(LIGHT_THEME_STORAGE_KEY);
    expect(html).toContain(DARK_THEME_STORAGE_KEY);
    expect(html).toContain('=== "dark"');
    expect(html).toContain('!== "light"');
    expect(html).toContain("prefers-color-scheme: dark");
    // Both hooks, stamped unconditionally — a one-sided add() would leave
    // .dark set against the light :root palette.
    expect(html).toContain('classList.toggle("dark"');
    expect(html).toContain('setAttribute("data-theme"');
    expect(html).not.toContain('class="dark"');
    // Containment alone would survive re-wrapping the stamps in `if (dark)`,
    // which is precisely the .dark-without-data-theme state (light :root
    // palette while every dark: utility fires) this shape exists to prevent.
    expect(html).not.toMatch(/if\s*\(\s*dark\s*\)/);
  });

  it("the FOUC script lists both id sets in the same order as theme.ts", () => {
    // The script falls back to ids[0] per slot, so the ORDER is the contract:
    // a reordered list silently changes the default palette.
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const lightList = LIGHT_THEMES.map((theme) => `"${theme.id}"`).join(", ");
    const darkList = DARK_THEMES.map((theme) => `"${theme.id}"`).join(", ");
    expect(html).toContain(`[${lightList}]`);
    expect(html).toContain(`[${darkList}]`);
    expect(LIGHT_THEMES[0].id).toBe(DEFAULT_LIGHT_THEME);
    expect(DARK_THEMES[0].id).toBe(DEFAULT_DARK_THEME);
  });
});

describe("palette slots", () => {
  it("defaults each slot and treats unknown stored ids as the default", () => {
    expect(getLightTheme()).toBe(DEFAULT_LIGHT_THEME);
    expect(getDarkTheme()).toBe(DEFAULT_DARK_THEME);

    window.localStorage.setItem(LIGHT_THEME_STORAGE_KEY, "banana");
    window.localStorage.setItem(DARK_THEME_STORAGE_KEY, "banana");
    expect(getLightTheme()).toBe(DEFAULT_LIGHT_THEME);
    expect(getDarkTheme()).toBe(DEFAULT_DARK_THEME);

    // A dark id stored in the light slot is not a light id — reject it too,
    // and symmetrically for a light id in the dark slot.
    window.localStorage.setItem(LIGHT_THEME_STORAGE_KEY, "forest-amber");
    expect(getLightTheme()).toBe(DEFAULT_LIGHT_THEME);
    window.localStorage.setItem(DARK_THEME_STORAGE_KEY, "newsprint");
    expect(getDarkTheme()).toBe(DEFAULT_DARK_THEME);
  });

  it("resolveActiveThemeId follows the mode, not the slot that changed", () => {
    stubMatchMedia(false);
    setLightTheme("newsprint");
    setDarkTheme("slate-blue");

    setThemePreference("light");
    expect(resolveActiveThemeId()).toBe("newsprint");

    setThemePreference("dark");
    expect(resolveActiveThemeId()).toBe("slate-blue");
  });

  it("applyThemeClass stamps data-theme on both branches", () => {
    stubMatchMedia(false);
    window.localStorage.setItem(LIGHT_THEME_STORAGE_KEY, "ice");
    window.localStorage.setItem(DARK_THEME_STORAGE_KEY, "forest-amber");

    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    applyThemeClass();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.getAttribute("data-theme")).toBe("ice");

    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    applyThemeClass();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "forest-amber",
    );
  });

  it("setting a slot persists it and restamps only when that slot is active", () => {
    stubMatchMedia(false);
    setThemePreference("light");

    setDarkTheme("slate-blue");
    expect(window.localStorage.getItem(DARK_THEME_STORAGE_KEY)).toBe(
      "slate-blue",
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      DEFAULT_LIGHT_THEME,
    );

    setLightTheme("newsprint");
    expect(window.localStorage.getItem(LIGHT_THEME_STORAGE_KEY)).toBe(
      "newsprint",
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      "newsprint",
    );
  });

  it("useTheme exposes both slots and re-renders when either changes", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.lightTheme).toBe(DEFAULT_LIGHT_THEME);
    expect(result.current.darkTheme).toBe(DEFAULT_DARK_THEME);
    expect(result.current.activeTheme).toBe(DEFAULT_DARK_THEME);

    act(() => {
      result.current.setDarkTheme("forest-amber");
    });
    expect(result.current.darkTheme).toBe("forest-amber");
    expect(result.current.activeTheme).toBe("forest-amber");

    act(() => {
      result.current.setLightTheme("ice");
    });
    expect(result.current.lightTheme).toBe("ice");
    // System resolves dark here, so the active palette is unchanged.
    expect(result.current.activeTheme).toBe("forest-amber");
  });
});
