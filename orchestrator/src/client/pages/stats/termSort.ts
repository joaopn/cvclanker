/**
 * Column sorting for the Job profile tab's term tables.
 *
 * A header click cycles ascending -> descending -> default, and the default is
 * alphabetical by term. The Term column skips its ascending step, which would
 * look identical to the default: it toggles between descending and default.
 *
 * A rate with nothing scored has no value; it sorts LAST in both directions,
 * so a dash never heads a "highest fit rate" list or a "lowest" one. Ties
 * fall back to alphabetical, so the order is stable.
 */

import type { StatsTermRow } from "@shared/types";

export type TermSortKey =
  | "term"
  | "scored"
  | "goodFit"
  | "applied"
  | "fitRate"
  | "appliedRate";

export type TermSort = { key: TermSortKey; direction: "asc" | "desc" } | null;

/** The sort after clicking `key`'s header. */
export function nextTermSort(current: TermSort, key: TermSortKey): TermSort {
  if (key === "term") {
    return current?.key === "term" ? null : { key, direction: "desc" };
  }
  if (current?.key !== key) return { key, direction: "asc" };
  return current.direction === "asc" ? { key, direction: "desc" } : null;
}

function byTerm(a: StatsTermRow, b: StatsTermRow): number {
  return a.term.localeCompare(b.term);
}

function sortValue(row: StatsTermRow, key: Exclude<TermSortKey, "term">) {
  switch (key) {
    case "scored":
      return row.scored;
    case "goodFit":
      return row.goodFit;
    case "applied":
      return row.applied;
    case "fitRate":
      return row.scored > 0 ? row.goodFit / row.scored : null;
    case "appliedRate":
      return row.scored > 0 ? row.applied / row.scored : null;
    default:
      key satisfies never;
      return null;
  }
}

/** A sorted copy; the input is left alone. */
export function sortTerms(
  rows: readonly StatsTermRow[],
  sort: TermSort,
): StatsTermRow[] {
  const sorted = [...rows];
  if (sort === null) return sorted.sort(byTerm);
  const sign = sort.direction === "asc" ? 1 : -1;
  if (sort.key === "term") {
    return sorted.sort((a, b) => sign * byTerm(a, b));
  }
  const key = sort.key;
  return sorted.sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
      return byTerm(a, b);
    }
    return sign * (left - right) || byTerm(a, b);
  });
}
