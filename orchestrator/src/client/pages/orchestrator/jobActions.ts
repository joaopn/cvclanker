import { extractExternalId } from "@shared/duplicate-identity";
import type { JobActionResponse, JobListItem } from "@shared/types";

const SKIPPABLE_STATUSES = new Set([
  "discovered",
  "selected",
  "ready",
  "backlog",
  "stale",
]);
const MOVE_TO_READY_STATUSES = new Set(["discovered", "backlog", "stale"]);
const MOVE_TO_BACKLOG_STATUSES = new Set([
  "discovered",
  "stale",
]);
const MOVE_TO_STALE_STATUSES = new Set([
  "discovered",
  "selected",
  "backlog",
]);
const MOVE_TO_INBOX_STATUSES = new Set(["stale"]);
const CLOSABLE_STATUSES = new Set(["applied", "in_progress"]);
const REOPENABLE_STATUSES = new Set(["skipped", "closed"]);

// A failed tailor sits at `processing` in the Tailoring tab (reason set); it can
// be retried (re-tailored) or skipped (given up on). Mirrors the server guards
// in api/routes/jobs.ts.
function isFailedProcessing(job: JobListItem): boolean {
  return job.status === "processing" && job.tailoringFailureReason != null;
}

export function canSkip(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 &&
    jobs.every(
      (job) => SKIPPABLE_STATUSES.has(job.status) || isFailedProcessing(job),
    )
  );
}

export function canMoveToReady(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 &&
    jobs.every(
      (job) =>
        MOVE_TO_READY_STATUSES.has(job.status) || isFailedProcessing(job),
    )
  );
}

/**
 * Re-tailoring (the bulk "Generate") targets rows that are ALREADY tailored,
 * i.e. `ready`. `some`, not `every`: the Tailoring tab also holds `processing`
 * rows, so select-all there is a mixed selection by construction — the
 * dispatcher sends the `ready` subset (same shape as `canFetchLiveStatus`)
 * instead of spraying per-job failures for rows the user did not single out.
 */
export function isRetailorable(job: JobListItem): boolean {
  return job.status === "ready";
}

export function canRetailor(jobs: JobListItem[]): boolean {
  return jobs.some(isRetailorable);
}

export function canRescore(jobs: JobListItem[]): boolean {
  return jobs.length > 0 && jobs.every((job) => job.status !== "processing");
}

/**
 * Clearing a score is only offered when at least one selected job actually has
 * one — on an all-unscored selection the action would be a silent no-op, and a
 * button that does nothing reads as broken.
 */
export function canClearScore(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 &&
    jobs.every((job) => job.status !== "processing") &&
    jobs.some((job) => job.suitabilityCategory != null)
  );
}

function isRescrapableUrl(url: string | null | undefined): boolean {
  return !!url && (url.startsWith("https://") || url.startsWith("http://"));
}

export function canRescrape(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 &&
    jobs.every(
      (job) => job.status !== "processing" && isRescrapableUrl(job.jobUrl),
    )
  );
}

export function canMoveToBacklog(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 &&
    jobs.every((job) => MOVE_TO_BACKLOG_STATUSES.has(job.status))
  );
}

export function canMoveToStale(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 &&
    jobs.every((job) => MOVE_TO_STALE_STATUSES.has(job.status))
  );
}

export function canMoveToInbox(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 &&
    jobs.every((job) => MOVE_TO_INBOX_STATUSES.has(job.status))
  );
}

export function canMarkClosed(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 && jobs.every((job) => CLOSABLE_STATUSES.has(job.status))
  );
}

export function canReopen(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 && jobs.every((job) => REOPENABLE_STATUSES.has(job.status))
  );
}

/**
 * Deleting is offered from every status — it is the "get this out of my
 * database" escape hatch, and a confirmation dialog stands in for the guards
 * the other actions use. The single exception mirrors the server: a row being
 * tailored right now has a detached background run still writing to it. A
 * failed tailor (same status, reason set) is deletable.
 */
export function canDelete(jobs: JobListItem[]): boolean {
  return (
    jobs.length > 0 &&
    jobs.every((job) => job.status !== "processing" || isFailedProcessing(job))
  );
}

/**
 * Live-status checks read LinkedIn's guest endpoint, keyed on the posting id
 * in the job's URL. URL-only on purpose: the server also accepts an id
 * recovered from `sourceJobId`, which list rows don't carry — this predicate
 * is a conservative subset and never admits a job the server would refuse.
 */
export function hasLinkedinPostingId(job: JobListItem): boolean {
  return extractExternalId({ jobUrl: job.jobUrl }) !== null;
}

/**
 * Offered when AT LEAST ONE selected job is a LinkedIn posting — mixed
 * selections are the norm on select-all, and the dispatcher sends only the
 * LinkedIn subset, so non-LinkedIn rows are skipped rather than failed.
 * (`some` on an empty selection is false, covering the no-selection case.)
 */
export function canFetchLiveStatus(jobs: JobListItem[]): boolean {
  return jobs.some(hasLinkedinPostingId);
}

export function getFailedJobIds(response: JobActionResponse): Set<string> {
  const failedIds = response.results
    .filter((result) => !result.ok)
    .map((result) => result.jobId);
  return new Set(failedIds);
}
