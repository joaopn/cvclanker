import { getMetaShortcutLabel } from "@client/lib/meta-key";
import type { FilterTab } from "@client/pages/orchestrator/constants";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ShortcutGroup = "navigation" | "actions" | "tabs" | "meta";

export interface ShortcutDef {
  /** tinykeys key descriptor, e.g. "j", "Shift+S", "$mod+K" */
  key: string;
  /** Human-readable key label shown in the UI, e.g. "j", "Shift+S", "Cmd+K" */
  displayKey: string;
  /** Short description shown in hints/help */
  label: string;
  /** Grouping for the help dialog */
  group: ShortcutGroup;
  /** Tabs where the shortcut is active. undefined = all tabs. */
  scope?: FilterTab[];
}

// ─── Definitions ─────────────────────────────────────────────────────────────

export const SHORTCUTS = {
  // Navigation
  nextJob: {
    key: "j",
    displayKey: "j",
    label: "Next job",
    group: "navigation",
  },
  nextJobArrow: {
    key: "ArrowDown",
    displayKey: "\u2193",
    label: "Next job",
    group: "navigation",
  },
  prevJob: {
    key: "k",
    displayKey: "k",
    label: "Previous job",
    group: "navigation",
  },
  prevJobArrow: {
    key: "ArrowUp",
    displayKey: "\u2191",
    label: "Previous job",
    group: "navigation",
  },

  // Tabs
  tabInbox: {
    key: "1",
    displayKey: "1",
    label: "Inbox tab",
    group: "tabs",
  },
  tabTailoring: {
    key: "2",
    displayKey: "2",
    label: "Tailoring tab",
    group: "tabs",
  },
  tabLive: {
    key: "3",
    displayKey: "3",
    label: "Live tab",
    group: "tabs",
  },
  tabBacklog: {
    key: "4",
    displayKey: "4",
    label: "Backlog tab",
    group: "tabs",
  },
  tabStale: {
    key: "5",
    displayKey: "5",
    label: "Stale tab",
    group: "tabs",
  },
  tabClosed: {
    key: "6",
    displayKey: "6",
    label: "Closed tab",
    group: "tabs",
  },
  tabAll: {
    key: "7",
    displayKey: "7",
    label: "All Jobs tab",
    group: "tabs",
  },
  prevTabArrow: {
    key: "ArrowLeft",
    displayKey: "\u2190",
    label: "Previous tab",
    group: "tabs",
  },
  nextTabArrow: {
    key: "ArrowRight",
    displayKey: "\u2192",
    label: "Next tab",
    group: "tabs",
  },

  // Context actions
  skip: {
    key: "s",
    displayKey: "s",
    label: "Skip job",
    group: "actions",
    scope: ["inbox", "tailoring", "backlog"],
  },
  // Same key as `skip`: the Stale tab's `s` closes instead (see close_stale).
  closeStale: {
    key: "s",
    displayKey: "s",
    label: "Close job",
    group: "actions",
    scope: ["stale"],
  },
  moveToReady: {
    key: "r",
    displayKey: "r",
    label: "Tailor job",
    group: "actions",
    scope: ["inbox", "backlog", "stale"],
  },
  markApplied: {
    key: "a",
    displayKey: "a",
    label: "Mark applied",
    group: "actions",
    scope: ["tailoring"],
  },
  moveToBacklog: {
    key: "b",
    displayKey: "b",
    label: "Move to Backlog",
    group: "actions",
    scope: ["inbox", "stale"],
  },
  moveToInbox: {
    key: "i",
    displayKey: "i",
    label: "Move to Inbox",
    group: "actions",
    scope: ["stale"],
  },
  reopenJob: {
    key: "u",
    displayKey: "u",
    label: "Reopen job",
    group: "actions",
    scope: ["closed"],
  },
  viewPdf: {
    key: "p",
    displayKey: "p",
    label: "View PDF",
    group: "actions",
    scope: ["tailoring"],
  },
  downloadPdf: {
    key: "d",
    displayKey: "d",
    label: "Download CV",
    group: "actions",
    scope: ["tailoring"],
  },
  openListing: {
    key: "o",
    displayKey: "o",
    label: "Open job listing",
    group: "actions",
  },
  toggleSelect: {
    key: "x",
    displayKey: "x",
    label: "Toggle select",
    group: "actions",
  },
  clearSelection: {
    key: "Escape",
    displayKey: "Esc",
    label: "Clear selection",
    group: "actions",
  },

  // Meta
  search: {
    key: "$mod+k",
    displayKey: "$mod+K",
    label: "Search jobs",
    group: "meta",
  },
  searchSlash: {
    key: "/",
    displayKey: "/",
    label: "Search jobs",
    group: "meta",
  },
  help: {
    key: "Shift+?",
    displayKey: "?",
    label: "Keyboard shortcuts",
    group: "meta",
  },
  undo: {
    key: "$mod+z",
    displayKey: "$mod+Z",
    label: "Undo last action",
    group: "actions",
  },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Return shortcuts that are active for the given tab, grouped by category.
 * Useful for rendering the bottom hint bar.
 */
export function getShortcutsForTab(tab: FilterTab): ShortcutDef[] {
  return (Object.values(SHORTCUTS) as ShortcutDef[]).filter((s) =>
    isShortcutInScope(s, tab),
  );
}

/**
 * Whether a shortcut's `scope` allows the current tab. The SHORTCUTS table is
 * declared with `as const satisfies`, so each `scope` narrows to a readonly
 * tuple of string literals — `Array.includes` then rejects any FilterTab
 * outside that tuple. This helper widens the array before the `includes`
 * call so callers can pass the active tab without per-shortcut casts.
 */
export function isShortcutInScope(
  def: { scope?: readonly FilterTab[] },
  tab: FilterTab,
): boolean {
  return !def.scope || (def.scope as readonly FilterTab[]).includes(tab);
}

/**
 * Group an array of ShortcutDefs by their `group` field.
 */
export function groupShortcuts(
  defs: ShortcutDef[],
): Record<ShortcutGroup, ShortcutDef[]> {
  const result: Record<ShortcutGroup, ShortcutDef[]> = {
    navigation: [],
    tabs: [],
    actions: [],
    meta: [],
  };
  for (const def of defs) {
    result[def.group].push(def);
  }
  return result;
}

/**
 * Get the platform-correct display label for a shortcut definition.
 */
export function getDisplayKey(def: ShortcutDef): string {
  if (def.displayKey.includes("$mod+")) {
    return getMetaShortcutLabel(def.displayKey.replace("$mod+", ""));
  }
  return def.displayKey;
}

/**
 * Deduplicate shortcuts that share the same label (e.g. j and ArrowDown both
 * map to "Next job"). Keeps the first occurrence and appends alternative
 * display keys.
 */
export interface DisplayShortcut {
  displayKeys: string[];
  label: string;
  group: ShortcutGroup;
}

export function dedupeShortcuts(defs: ShortcutDef[]): DisplayShortcut[] {
  const seen = new Map<string, DisplayShortcut>();
  const result: DisplayShortcut[] = [];
  for (const def of defs) {
    const displayKey = getDisplayKey(def);
    const existing = seen.get(def.label);
    if (existing) {
      existing.displayKeys.push(displayKey);
    } else {
      const entry: DisplayShortcut = {
        displayKeys: [displayKey],
        label: def.label,
        group: def.group,
      };
      seen.set(def.label, entry);
      result.push(entry);
    }
  }
  return result;
}
