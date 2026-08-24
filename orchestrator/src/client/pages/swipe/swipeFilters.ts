/**
 * Pure filter layer for the Swipe deck's bottom filter sheet. Mirrors the
 * Manage view's badge-family semantics (useFilteredJobs): within a family the
 * picks OR, across families they AND, and an empty family narrows nothing.
 */

import type { Job } from "@shared/types.js";
import type { FitFilterValue } from "../orchestrator/constants";
import { UNATTRIBUTED_PROFILE_ID } from "../orchestrator/constants";

export interface SwipeFilterState {
  fit: FitFilterValue[];
  profile: string[];
  title: string[];
}

export const EMPTY_SWIPE_FILTERS: SwipeFilterState = {
  fit: [],
  profile: [],
  title: [],
};

export const hasActiveSwipeFilters = (filters: SwipeFilterState): boolean =>
  filters.fit.length > 0 ||
  filters.profile.length > 0 ||
  filters.title.length > 0;

const intersect = (selected: string[], offered: string[]): string[] => {
  if (selected.length === 0) return selected;
  const available = new Set(offered);
  return selected.filter((value) => available.has(value));
};

/**
 * The selections that actually narrow: each family's picks intersected
 * against the badges actually offered (a deleted profile or an edited-away
 * search term must not keep narrowing with no badge left to clear it),
 * matching the Manage bar's keepOfferedChips rule. The trigger's active
 * indicator keys on this, not the raw picks, so it never claims filtering
 * that no longer happens.
 */
export function effectiveSwipeFilters(
  filters: SwipeFilterState,
  knownProfileIds: string[],
  offeredTitles: string[],
): SwipeFilterState {
  return {
    // Fit badges are static — all five are always offered.
    fit: filters.fit,
    // With no profiles the sheet shows a hint instead of badges, so nothing
    // is offered and a stale pick stops narrowing.
    profile: intersect(
      filters.profile,
      knownProfileIds.length === 0
        ? []
        : [...knownProfileIds, UNATTRIBUTED_PROFILE_ID],
    ),
    title: intersect(filters.title, offeredTitles),
  };
}

/** Narrows the deck by the sheet's effective selections. */
export function applySwipeFilters(
  jobs: Job[],
  filters: SwipeFilterState,
  knownProfileIds: string[],
  offeredTitles: string[],
): Job[] {
  const effective = effectiveSwipeFilters(
    filters,
    knownProfileIds,
    offeredTitles,
  );
  let filtered = jobs;

  if (effective.fit.length > 0) {
    const set = new Set(effective.fit);
    filtered = filtered.filter((job) => {
      if (job.suitabilityCategory == null) return set.has("unscored");
      return set.has(job.suitabilityCategory);
    });
  }

  if (effective.profile.length > 0) {
    const set = new Set(effective.profile);
    const known = new Set(knownProfileIds);
    filtered = filtered.filter((job) => {
      // Unattributed covers both "never had a profile" and "had one that has
      // since been deleted" — in both cases no profile badge names the row.
      if (job.profileId == null || !known.has(job.profileId)) {
        return set.has(UNATTRIBUTED_PROFILE_ID);
      }
      return set.has(job.profileId);
    });
  }

  if (effective.title.length > 0) {
    const terms = effective.title
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length > 0) {
      filtered = filtered.filter((job) => {
        const title = job.title.toLowerCase();
        return terms.some((term) => title.includes(term));
      });
    }
  }

  return filtered;
}
