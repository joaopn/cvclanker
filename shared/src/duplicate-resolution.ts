/**
 * Which copy of a duplicate group to KEEP, and which to close.
 *
 * In `shared/` because two things now decide it: the review wizard a user steps
 * through, and the scheduler's automatic resolver. They must agree exactly — a
 * resolver that picked a different keeper would close the row the user was
 * about to keep, and there is no server-side undo.
 */

import type { DuplicateJobGroup, JobListItem, JobStatus } from "./types/jobs";
import { SUITABILITY_CATEGORY_RANK } from "./types/jobs";

/**
 * Keeper priority by pipeline position: Live (applied/in_progress) > Ready >
 * Selected (selected/processing) > Inbox (discovered). Statuses not listed
 * (backlog/stale/skipped/closed) rank lowest. Higher wins.
 */
export const STATUS_KEEPER_RANK: Partial<Record<JobStatus, number>> = {
  applied: 4,
  in_progress: 4,
  ready: 3,
  selected: 2,
  processing: 2,
  discovered: 1,
};

function statusKeeperRank(job: JobListItem): number {
  return STATUS_KEEPER_RANK[job.status] ?? 0;
}

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fitRank(job: JobListItem): number {
  return job.suitabilityCategory
    ? SUITABILITY_CATEGORY_RANK[job.suitabilityCategory]
    : -1;
}

/**
 * Default keeper: furthest along the pipeline first (Live > Ready > Selected >
 * Inbox), then best fit, then newest posting, then newest discovered.
 */
export function chooseKeeper(jobs: JobListItem[]): string {
  const sorted = [...jobs].sort((a, b) => {
    const status = statusKeeperRank(b) - statusKeeperRank(a);
    if (status !== 0) return status;
    const fit = fitRank(b) - fitRank(a);
    if (fit !== 0) return fit;
    const posted =
      (parseDate(b.datePosted) ?? 0) - (parseDate(a.datePosted) ?? 0);
    if (posted !== 0) return posted;
    return (parseDate(b.discoveredAt) ?? 0) - (parseDate(a.discoveredAt) ?? 0);
  });
  return sorted[0]?.id ?? "";
}

/**
 * The copies a group would close — everything but its chosen keeper.
 *
 * The `chooseKeeper` fallback is load-bearing: groups the user never stepped
 * through have no recorded keeper, and a missing key must never make the whole
 * group (keeper included) look like a loser.
 */
export function losersOf(
  group: DuplicateJobGroup,
  keeperByKey: Record<string, string>,
): JobListItem[] {
  const keeperId = keeperByKey[group.key] || chooseKeeper(group.jobs);
  return group.jobs.filter((job) => job.id !== keeperId);
}
