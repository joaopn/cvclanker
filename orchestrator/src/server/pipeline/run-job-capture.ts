import type {
  CapturedRunJob,
  CreateJobInput,
  RunJobBucket,
} from "@shared/types";

/**
 * In-memory capture of the actual jobs behind each per-source funnel count for
 * the current run. The banner's clickable counts read from here. Reset at the
 * start of every run (alongside progress state); a server restart loses it,
 * which matches the banner only ever showing the latest run.
 *
 * Captures are grouped by SCOPE: the empty string for an ordinary run, and the
 * Search Profile id for each profile of a multi-profile chain. The banner keeps
 * one page of funnel rows per profile, so a click on page 1's count has to read
 * page 1's jobs — a single flat store would answer every page with the last
 * profile's captures.
 */
type SourceBuckets = Record<RunJobBucket, CapturedRunJob[]>;

const captureByScope = new Map<string, Map<string, SourceBuckets>>();
let activeScope = "";

function emptyBuckets(): SourceBuckets {
  return { scraped: [], imported: [], duplicated: [], rejected: [] };
}

function scopeStore(scope: string): Map<string, SourceBuckets> {
  let store = captureByScope.get(scope);
  if (!store) {
    store = new Map<string, SourceBuckets>();
    captureByScope.set(scope, store);
  }
  return store;
}

/**
 * Point every subsequent capture at one profile's page. Called as a chain moves
 * from profile to profile (and back to `""` when it ends), so no capture call
 * site has to know that chains exist.
 */
export function setRunCaptureScope(scope: string): void {
  activeScope = scope;
}

export function toCapturedRunJob(
  input: CreateJobInput,
  reason?: string,
): CapturedRunJob {
  return {
    title: input.title,
    employer: input.employer,
    jobUrl: input.jobUrl,
    applicationLink: input.applicationLink,
    employerUrl: input.employerUrl,
    location: input.location,
    datePosted: input.datePosted,
    deadline: input.deadline,
    salary: input.salary,
    jobType: input.jobType,
    jobLevel: input.jobLevel,
    jobFunction: input.jobFunction,
    isRemote: input.isRemote,
    reason,
  };
}

/**
 * Clear the captures of the run that is starting. Scoped to the active profile,
 * because every profile of a chain starts its own run and must not wipe the
 * pages already on the banner.
 */
export function resetRunJobCapture(): void {
  captureByScope.delete(activeScope);
}

/** Drop every scope's captures and go back to the unscoped store. */
export function resetAllRunJobCaptures(): void {
  captureByScope.clear();
  activeScope = "";
}

/**
 * Clear one source's captured buckets. Used by a per-source re-run so that
 * re-running a source drops its stale captures (instead of stacking onto
 * them) while leaving every other source's captures intact.
 */
export function resetRunJobCaptureForSource(source: string): void {
  captureByScope.get(activeScope)?.delete(source);
}

/** Append captured jobs to a source's bucket (called as the run progresses). */
export function captureRunJobs(
  source: string,
  bucket: RunJobBucket,
  jobs: CapturedRunJob[],
): void {
  if (jobs.length === 0) return;
  const store = scopeStore(activeScope);
  let buckets = store.get(source);
  if (!buckets) {
    buckets = emptyBuckets();
    store.set(source, buckets);
  }
  buckets[bucket].push(...jobs);
}

/**
 * Read one bucket back. `scope` defaults to the unscoped store rather than the
 * active one: reads arrive from the client long after the capture happened, so
 * resolving them against whatever profile happens to be running would answer a
 * question about page 1 with page 3's jobs.
 */
export function getRunJobs(
  source: string,
  bucket: RunJobBucket,
  scope = "",
): CapturedRunJob[] {
  return captureByScope.get(scope)?.get(source)?.[bucket] ?? [];
}
