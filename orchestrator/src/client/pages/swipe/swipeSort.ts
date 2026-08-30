/**
 * Pure sort layer for the Swipe deck's bottom sheet. The ordering itself is
 * the Manage list's — same `JobSorter` values, same `compareJobs` — so a
 * sorter means the same thing on both surfaces.
 */

import type { Job } from "@shared/types.js";
import { JOB_SORTER_SORTS, type JobSorter } from "../orchestrator/constants";
import { compareJobs } from "../orchestrator/utils";

/**
 * `none` returns the deck untouched — `useSwipeDeck` already orders it
 * fit-first, which is what the deck did before this control existed, and is
 * exactly what Manage's "None" means there.
 *
 * A set sorter REPLACES that fit-first order rather than tie-breaking inside
 * it, so a bad fit can become card #1. Deliberate: the two surfaces must not
 * mean different things under one label, and the sheet's own Fit row is the
 * mitigation — narrow to the tiers worth triaging, then order those by
 * whichever sort you came for.
 *
 * The sorted result is a COPY: `applySwipeFilters` hands back its input array
 * when no family narrows, and that array is the deck hook's own.
 */
export function applySwipeSort(jobs: Job[], sorter: JobSorter): Job[] {
  if (sorter === "none") return jobs;
  const sort = JOB_SORTER_SORTS[sorter];
  return [...jobs].sort((a, b) => compareJobs(a, b, sort));
}
