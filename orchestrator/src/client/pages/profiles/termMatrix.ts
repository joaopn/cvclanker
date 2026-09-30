/**
 * Pure helpers behind the Profiles page's term matrix: one row per search
 * term across every Search Profile, one column per profile.
 *
 * A row is identified by its trimmed, lowercased text, so "ML Engineer" on one
 * profile and "ml engineer" on another are the same row. The row shows the
 * first spelling met, and a profile that gains a term through the matrix gets
 * that spelling appended.
 */
import { termKey } from "@shared/term-budgets.js";
import type { Profile } from "@shared/types";

export { termKey };

export interface TermRow {
  key: string;
  label: string;
}

/** Every term any profile searches, sorted case-insensitively. */
export function collectTermRows(
  profiles: readonly Profile[],
  extra: readonly TermRow[] = [],
): TermRow[] {
  const byKey = new Map<string, string>();
  for (const profile of profiles) {
    for (const term of profile.config.searchTerms) {
      const key = termKey(term);
      if (key && !byKey.has(key)) byKey.set(key, term.trim());
    }
  }
  for (const row of extra) {
    if (!byKey.has(row.key)) byKey.set(row.key, row.label);
  }
  return [...byKey.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
}

export function termKeysOf(profile: Profile): Set<string> {
  return new Set(profile.config.searchTerms.map(termKey).filter(Boolean));
}

export function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/**
 * The profile's new term list for a selection: its existing terms that are
 * still selected keep their order and spelling (a duplicate spelling of one
 * row collapses to the first), then newly selected rows are appended in row
 * order.
 */
export function nextSearchTerms(
  profile: Profile,
  selected: ReadonlySet<string>,
  rows: readonly TermRow[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of profile.config.searchTerms) {
    const key = termKey(term);
    if (!selected.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(term.trim());
  }
  for (const row of rows) {
    if (!selected.has(row.key) || seen.has(row.key)) continue;
    seen.add(row.key);
    out.push(row.label);
  }
  return out;
}

/**
 * What a row's job-budget cell shows for the profiles it is ticked on: their
 * common override, none (each uses its own default), or "mixed".
 */
export type RowBudgetState =
  | { kind: "same"; value: number }
  | { kind: "none" }
  | { kind: "mixed" };

export function rowBudgetState(
  profiles: readonly Profile[],
  key: string,
): RowBudgetState {
  const values = new Set<number | null>();
  for (const profile of profiles) {
    const overrides = profile.config.termJobBudgets;
    values.add(Object.hasOwn(overrides, key) ? overrides[key] : null);
  }
  if (values.size !== 1)
    return values.size === 0 ? { kind: "none" } : { kind: "mixed" };
  const [only] = values;
  return only === null ? { kind: "none" } : { kind: "same", value: only };
}

/** A row's budget edit: a number sets the override, null clears it. */
export type BudgetEdit = number | null;

/**
 * The profile's overrides after the matrix's budget edits, kept to the terms
 * the profile will search (as the server keeps them). An edit applies only to
 * a term the profile has ticked.
 */
export function nextTermJobBudgets(
  profile: Profile,
  selected: ReadonlySet<string>,
  edits: ReadonlyMap<string, BudgetEdit>,
): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  const stored = profile.config.termJobBudgets;
  for (const key of selected) {
    if (edits.has(key)) {
      const edit = edits.get(key);
      if (typeof edit === "number") out[key] = edit;
    } else if (Object.hasOwn(stored, key)) {
      out[key] = stored[key];
    }
  }
  return out;
}

export function sameBudgets(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && b[key] === a[key]);
}
