import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeClass,
  getThemePreference,
  resolveIsDark,
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

  it("the index.html FOUC script mirrors the storage key and resolution literals", () => {
    // In the tools image this reads the BAKED index.html (only src/ is
    // bind-mounted), so it hard-pins the theme.ts side of the lockstep; an
    // html-side-only edit needs an image rebuild to be seen here.
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(html).toContain('=== "dark"');
    expect(html).toContain('!== "light"');
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).not.toContain('class="dark"');
  });
});
