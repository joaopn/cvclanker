import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DARK_THEMES, LIGHT_THEMES } from "@/lib/theme";

// Every palette must declare EVERY token. :root carries the default light
// palette and therefore acts as the fallback for any token a [data-theme]
// block omits — so an omission is silent at runtime and shows up only as, say,
// a light-scheme --popover-foreground inside a dark theme. This pins the shape
// instead. src/index.css is inside the orchestrator/src bind-mount, so unlike
// the index.html lockstep in theme.test.ts this needs no tools-image rebuild.
const PALETTE_KEYS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
  "--status-good",
  "--status-warn",
  "--status-bad",
  "--status-info",
  "--accent-cyan",
  "--accent-purple",
  "--badge-base",
  "--badge-muted",
  "--badge-muted-fg",
] as const;

// Fixed hues live once in :root and are deliberately NOT per-palette.
const SHARED_BADGE_HUES = [
  "--badge-good",
  "--badge-info",
  "--badge-warn",
  "--badge-bad",
  "--badge-cyan",
  "--badge-purple",
  "--badge-neutral",
] as const;

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

function declaredKeys(selector: string): Set<string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`no CSS block for selector ${selector}`);
  return new Set(
    Array.from(match[1].matchAll(/(--[a-z0-9-]+):/g), (m) => m[1]),
  );
}

// Sandstone is :root itself — there is deliberately no duplicate block for it.
const DEFAULT_LIGHT_ID = LIGHT_THEMES[0].id;
const EXPLICIT_THEMES = [...LIGHT_THEMES, ...DARK_THEMES]
  .map((theme) => theme.id)
  .filter((id) => id !== DEFAULT_LIGHT_ID);

describe("index.css palettes", () => {
  it("declares a block for every selectable palette except the :root default", () => {
    for (const id of EXPLICIT_THEMES) {
      expect(css).toContain(`:root[data-theme="${id}"]`);
    }
    expect(css).not.toContain(`:root[data-theme="${DEFAULT_LIGHT_ID}"]`);
  });

  it("has no palette block that theme.ts does not offer", () => {
    // The reverse direction. Without it, renaming an id in theme.ts (or a typo
    // in a selector) leaves an orphan block that matches nothing — the id then
    // resolves to :root sandstone, under a .dark class on the dark slots.
    const declared = [
      ...css.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]/g),
    ].map((match) => match[1]);
    expect([...new Set(declared)].sort()).toEqual([...EXPLICIT_THEMES].sort());
  });

  it(":root carries a complete palette plus the shared badge hues", () => {
    const keys = declaredKeys(":root");
    for (const key of [...PALETTE_KEYS, ...SHARED_BADGE_HUES]) {
      expect(keys.has(key), `:root is missing ${key}`).toBe(true);
    }
  });

  it("every explicit palette declares exactly the palette key set", () => {
    for (const id of EXPLICIT_THEMES) {
      const keys = declaredKeys(`:root[data-theme="${id}"]`);
      for (const key of PALETTE_KEYS) {
        expect(keys.has(key), `${id} is missing ${key}`).toBe(true);
      }
      const extras = [...keys].filter(
        (key) => !(PALETTE_KEYS as readonly string[]).includes(key),
      );
      expect(extras, `${id} declares unexpected keys`).toEqual([]);
    }
  });

  it("declares color-scheme on every palette, including the :root default", () => {
    const lightIds = LIGHT_THEMES.map((theme) => theme.id);
    for (const id of EXPLICIT_THEMES) {
      const escaped = `:root[data-theme="${id}"]`.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      const body = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
      const expected = (lightIds as readonly string[]).includes(id)
        ? "light"
        : "dark";
      expect(body?.[1]).toContain(`color-scheme: ${expected};`);
    }
    // :root is a real palette too — without this its color-scheme could be
    // dropped silently, and native controls would stop following the theme.
    expect(css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1]).toContain(
      "color-scheme: light;",
    );
  });

  it("keeps .dark free of color declarations", () => {
    // .dark is only the @custom-variant hook; palettes come from data-theme.
    // A colour on .dark would beat :root but lose to every [data-theme] block,
    // which is exactly the kind of half-applied palette this split removes.
    // Matched loosely on purpose: `html.dark {`, `.dark, :root {` and an
    // indented `  .dark {` all reintroduce the same problem.
    expect(css).not.toMatch(/(^|[\s,{}])\.dark\b[^{]*\{/);
  });
});
