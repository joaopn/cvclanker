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

export function canRescore(jobs: JobListItem[]): boolean {
  return jobs.length > 0 && jobs.every((job) => job.status !== "processing");
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

export function getFailedJobIds(response: JobActionResponse): Set<string> {
  const failedIds = response.results
    .filter((result) => !result.ok)
    .map((result) => result.jobId);
  return new Set(failedIds);
}
