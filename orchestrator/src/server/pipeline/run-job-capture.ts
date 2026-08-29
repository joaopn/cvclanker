import type {
  CapturedRunJob,
  CreateJobInput,
  RunJobBucket,
  RunTrigger,
} from "@shared/types";

/**
 * In-memory capture of the actual jobs behind each per-source funnel count for
 * the current run. The banner's clickable counts read from here. Reset at the
 * start of every run (alongside progress state); a server restart loses it,
 * which matches the banner only ever showing the latest run.
 *
 * Captures are grouped by SCOPE, which has two independent parts:
 *
 * - the TRIGGER, because a manual and a scheduled run each keep their own
 *   retained funnel: a scheduled run starting must not make the still-visible
 *   manual table's counts open empty dialogs, and vice versa;
 * - the Search Profile id, empty for an ordinary run and set for each profile
 *   of a multi-profile chain. The banner keeps one page of funnel rows per
 *   profile, so a click on page 1's count has to read page 1's jobs — a single
 *   flat store would answer every page with the last profile's captures.
 *
 * They are held apart rather than as one composed string because they are set
 * at different moments by different callers: the trigger at run start, the
 * profile as a chain advances (and by a per-source re-run, BEFORE the run that
 * establishes the trigger — so a trigger change must not clear it).
 */
type SourceBuckets = Record<RunJobBucket, CapturedRunJob[]>;

const captureByScope = new Map<string, Map<string, SourceBuckets>>();
let activeTrigger: RunTrigger = "manual";
let activeProfileScope = "";

/**
 * The eviction sweep in `resetAllRunJobCaptures` matches on the `<trigger>:`
 * prefix, so this separator must not appear in a trigger id. It cannot: the ids
 * are the two literals of `RUN_TRIGGERS`, and the profile id is the suffix.
 */
function scopeKey(trigger: RunTrigger, profileId: string): string {
  return `${trigger}:${profileId}`;
}

function activeScopeKey(): string {
  return scopeKey(activeTrigger, activeProfileScope);
}

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
 * Point every subsequent capture at one partition. Called once at run start,
 * via `setActiveRunTrigger`, so the two stay in step.
 *
 * Deliberately leaves the profile scope alone: a per-source re-run aims itself
 * at a page (`targetProfileRunPage`) BEFORE the run that sets the trigger, and
 * clearing the profile here would throw that aim away.
 */
export function setRunCaptureTrigger(trigger: RunTrigger): void {
  activeTrigger = trigger;
}

/**
 * Point every subsequent capture at one profile's page. Called as a chain moves
 * from profile to profile (and back to `""` when it ends), so no capture call
 * site has to know that chains exist.
 */
export function setRunCaptureScope(scope: string): void {
  activeProfileScope = scope;
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
  captureByScope.delete(activeScopeKey());
}

/**
 * Drop every scope's captures for the ACTIVE trigger and point captures back at
 * the unscoped profile. Scoped to one partition because the other one's
 * table is still on screen: this fires when a new run starts, and a manual run
 * clearing a retained scheduled run's captures (or the reverse) would leave
 * that table's counts opening empty dialogs.
 */
export function resetAllRunJobCaptures(): void {
  const prefix = `${activeTrigger}:`;
  for (const scope of [...captureByScope.keys()]) {
    if (scope.startsWith(prefix)) captureByScope.delete(scope);
  }
  activeProfileScope = "";
}

/**
 * Clear one source's captured buckets. Used by a per-source re-run so that
 * re-running a source drops its stale captures (instead of stacking onto
 * them) while leaving every other source's captures intact.
 */
export function resetRunJobCaptureForSource(source: string): void {
  captureByScope.get(activeScopeKey())?.delete(source);
}

/** Append captured jobs to a source's bucket (called as the run progresses). */
export function captureRunJobs(
  source: string,
  bucket: RunJobBucket,
  jobs: CapturedRunJob[],
): void {
  if (jobs.length === 0) return;
  const store = scopeStore(activeScopeKey());
  let buckets = store.get(source);
  if (!buckets) {
    buckets = emptyBuckets();
    store.set(source, buckets);
  }
  buckets[bucket].push(...jobs);
}

/**
 * Read one bucket back. Both parts of the scope default to the UNSCOPED manual
 * store rather than to whatever is active: reads arrive from the client long
 * after the capture happened, so resolving them against whatever happens to be
 * running would answer a question about page 1 with page 3's jobs — or a
 * question about the manual table with a scheduled run's.
 */
export function getRunJobs(
  source: string,
  bucket: RunJobBucket,
  profileId = "",
  trigger: RunTrigger = "manual",
): CapturedRunJob[] {
  return (
    captureByScope.get(scopeKey(trigger, profileId))?.get(source)?.[bucket] ??
    []
  );
}
