/**
 * Pure helpers behind the Profiles page's term matrix: one row per search
 * term across every Search Profile, one column per profile.
 *
 * A row is identified by its trimmed, lowercased text, so "ML Engineer" on one
 * profile and "ml engineer" on another are the same row. The row shows the
 * first spelling met, and a profile that gains a term through the matrix gets
 * that spelling appended.
 */
import type { Profile } from "@shared/types";

export interface TermRow {
  key: string;
  label: string;
}

export function termKey(term: string): string {
  return term.trim().toLowerCase();
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
