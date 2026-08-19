import { logger } from "@infra/logger";
import {
  EXTRACTOR_SOURCE_METADATA,
  isExtractorSourceId,
  sourceLabel as resolveExtractorLabel,
} from "@shared/extractors";
import type {
  PipelineProfileRun,
  PipelineProfileRunStats,
  PipelineProgressEvent,
  PipelineProgressStep,
  PipelineSourceStats,
  PipelineSourceStatus,
} from "@shared/types";
import {
  resetAllRunJobCaptures,
  resetRunJobCaptureForSource,
  setRunCaptureScope,
} from "./run-job-capture";

/**
 * Pipeline progress tracking with Server-Sent Events.
 */

export type PipelineStep = PipelineProgressStep;

export type CrawlSource = string;

export type PipelineProgress = PipelineProgressEvent;

// Event emitter for progress updates
type ProgressListener = (progress: PipelineProgress) => void;
const listeners: Set<ProgressListener> = new Set();

let currentProgress: PipelineProgress = {
  step: "idle",
  message: "Ready",
  crawlingSource: null,
  crawlingSourcesCompleted: 0,
  crawlingSourcesTotal: 0,
  crawlingTermsProcessed: 0,
  crawlingTermsTotal: 0,
  crawlingListPagesProcessed: 0,
  crawlingListPagesTotal: 0,
  crawlingJobCardsFound: 0,
  crawlingJobPagesEnqueued: 0,
  crawlingJobPagesSkipped: 0,
  crawlingJobPagesProcessed: 0,
  jobsDiscovered: 0,
  jobsScored: 0,
  jobsProcessed: 0,
  totalToProcess: 0,
  sourceStats: [],
};

const emptyCrawlingStats = {
  crawlingTermsProcessed: 0,
  crawlingTermsTotal: 0,
  crawlingListPagesProcessed: 0,
  crawlingListPagesTotal: 0,
  crawlingJobCardsFound: 0,
  crawlingJobPagesEnqueued: 0,
  crawlingJobPagesSkipped: 0,
  crawlingJobPagesProcessed: 0,
  crawlingPhase: undefined,
  crawlingCurrentUrl: undefined,
};

type SourceCrawlingStats = {
  termsProcessed: number;
  termsTotal: number;
  listPagesProcessed: number;
  listPagesTotal: number;
  jobCardsFound: number;
  jobPagesEnqueued: number;
  jobPagesSkipped: number;
  jobPagesProcessed: number;
};

const emptySourceCrawlingStats = (): SourceCrawlingStats => ({
  termsProcessed: 0,
  termsTotal: 0,
  listPagesProcessed: 0,
  listPagesTotal: 0,
  jobCardsFound: 0,
  jobPagesEnqueued: 0,
  jobPagesSkipped: 0,
  jobPagesProcessed: 0,
});

const crawlingStatsBySource = new Map<CrawlSource, SourceCrawlingStats>();

type SourceStatsInternal = {
  id: string;
  label: string;
  status: PipelineSourceStatus;
  jobsScraped: number;
  jobsImported: number;
  jobsReposted: number;
  jobsDuplicated: number;
  jobsUnmappable: number;
  jobsFiltered: number;
  jobsRejected: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  order: number;
};

const sourceStatsByPlatform = new Map<string, SourceStatsInternal>();
let sourceRowFallbackCounter = 0;

function resolveSourceLabel(id: string): string {
  if (isExtractorSourceId(id)) return resolveExtractorLabel(id);
  return id;
}

function resolveSourceOrder(id: string): number {
  if (isExtractorSourceId(id)) {
    return EXTRACTOR_SOURCE_METADATA[id].order;
  }
  sourceRowFallbackCounter += 1;
  return 9000 + sourceRowFallbackCounter;
}

function getOrCreateSourceRow(
  platform: string,
  labelOverride?: string,
): SourceStatsInternal {
  const existing = sourceStatsByPlatform.get(platform);
  if (existing) {
    if (labelOverride && existing.label !== labelOverride) {
      existing.label = labelOverride;
    }
    return existing;
  }
  const row: SourceStatsInternal = {
    id: platform,
    label: labelOverride ?? resolveSourceLabel(platform),
    status: "pending",
    jobsScraped: 0,
    jobsImported: 0,
    jobsReposted: 0,
    jobsDuplicated: 0,
    jobsUnmappable: 0,
    jobsFiltered: 0,
    jobsRejected: 0,
    order: resolveSourceOrder(platform),
  };
  sourceStatsByPlatform.set(platform, row);
  return row;
}

function buildSourceStats(): PipelineSourceStats[] {
  return [...sourceStatsByPlatform.values()]
    .sort((left, right) => left.order - right.order)
    .map((row) => ({
      id: row.id,
      label: row.label,
      status: row.status,
      jobsScraped: row.jobsScraped,
      jobsImported: row.jobsImported,
      jobsReposted: row.jobsReposted,
      jobsDuplicated: row.jobsDuplicated,
      jobsUnmappable: row.jobsUnmappable,
      jobsFiltered: row.jobsFiltered,
      jobsRejected: row.jobsRejected,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      durationMs: row.durationMs,
      error: row.error,
    }));
}

function markRowTerminal(
  row: SourceStatsInternal,
  status: "completed" | "failed",
  error?: string,
) {
  const completedAt = new Date().toISOString();
  row.status = status;
  row.completedAt = completedAt;
  if (row.startedAt) {
    row.durationMs = Math.max(
      0,
      new Date(completedAt).getTime() - new Date(row.startedAt).getTime(),
    );
  }
  if (status === "failed" && error) {
    row.error = error;
  }
}

function aggregateCrawlingStats() {
  let termsProcessed = 0;
  let termsTotal = 0;
  let listPagesProcessed = 0;
  let listPagesTotal = 0;
  let jobCardsFound = 0;
  let jobPagesEnqueued = 0;
  let jobPagesSkipped = 0;
  let jobPagesProcessed = 0;

  for (const stats of crawlingStatsBySource.values()) {
    termsProcessed += stats.termsProcessed;
    termsTotal += stats.termsTotal;
    listPagesProcessed += stats.listPagesProcessed;
    listPagesTotal += stats.listPagesTotal;
    jobCardsFound += stats.jobCardsFound;
    jobPagesEnqueued += stats.jobPagesEnqueued;
    jobPagesSkipped += stats.jobPagesSkipped;
    jobPagesProcessed += stats.jobPagesProcessed;
  }

  return {
    termsProcessed,
    termsTotal,
    listPagesProcessed,
    listPagesTotal,
    jobCardsFound,
    jobPagesEnqueued,
    jobPagesSkipped,
    jobPagesProcessed,
  };
}

/**
 * Which profile of a multi-profile sequence is running right now. Stamped onto
 * every emitted event (and onto the reset state) rather than passed through the
 * helpers, so no progress helper — and nothing inside `runPipeline` — has to
 * know sequences exist.
 */
let activeProfileRun: PipelineProfileRun | null = null;

/**
 * The retained page a per-source re-run reconciles into, when that re-run was
 * fired from one page of a multi-profile run. Deliberately NOT `activeProfileRun`:
 * that one also TAGS every emitted event, and a tagged terminal is precisely
 * what tells the client "one profile of a chain ended, the run continues". A
 * re-run IS the whole run, so it stays untagged and its terminal ends the run.
 */
let rerunPageProfile: PipelineProfileRun | null = null;

/** The page rows are stamped onto: a chain's current profile, or a re-run's target. */
function statsPageProfile(): PipelineProfileRun | null {
  return activeProfileRun ?? rerunPageProfile;
}

/**
 * One retained page of funnel rows per profile a chain has reached, keyed by
 * 1-based profile index. `sourceStatsByPlatform` is wiped by every profile's
 * own `runPipeline`, so without this the banner would finish a chain knowing
 * only the last profile's counts and failed sources.
 */
const profileRunStats = new Map<number, PipelineProfileRunStats>();

function buildProfileRunStats(): PipelineProfileRunStats[] {
  return [...profileRunStats.values()].sort(
    (left, right) => left.profile.index - right.profile.index,
  );
}

/** Drop every retained page. Called when a new chain starts. */
export function resetProfileRunStats(): void {
  profileRunStats.clear();
  rerunPageProfile = null;
  resetAllRunJobCaptures();
}

/**
 * Aim a per-source re-run at one retained page: that page's rows become the live
 * funnel (so the re-run reconciles into the profile it was fired from rather
 * than into whichever profile happened to run last), its captures go to that
 * profile's scope, and every subsequent `updateProgress` re-stamps the page.
 *
 * Returns false and changes nothing when no page matches — an ordinary single
 * run, or a chain this process has since forgotten — leaving the caller on the
 * flat-funnel path. Call it BEFORE `runPipeline`: the reset at the head of that
 * run is what reads the seeded rows back out.
 */
export function targetProfileRunPage(profileId: string): boolean {
  const page = [...profileRunStats.values()].find(
    (candidate) => candidate.profile.id === profileId,
  );
  if (!page) return false;
  rerunPageProfile = page.profile;
  setRunCaptureScope(page.profile.id);
  sourceStatsByPlatform.clear();
  sourceRowFallbackCounter = 0;
  // Rebuilt in page order, so the fallback orders handed to provider-instance
  // rows reproduce the order the page already had.
  for (const row of page.sourceStats) {
    sourceStatsByPlatform.set(row.id, {
      ...row,
      order: resolveSourceOrder(row.id),
    });
  }
  return true;
}

/** Stop aiming at a page, once the re-run that was aimed at it has finished. */
export function clearProfileRunPageTarget(): void {
  if (rerunPageProfile === null) return;
  rerunPageProfile = null;
  setRunCaptureScope("");
}

export function setActiveProfileRun(value: PipelineProfileRun | null): void {
  activeProfileRun = value;
  // A chain owns the banner outright, so it supersedes any page a re-run was
  // aimed at — and clearing on `null` too keeps a crashed re-run from leaving
  // the target set for the next ordinary run.
  rerunPageProfile = null;
  // Captured jobs follow the page they belong to, so a click on page 1's count
  // reads page 1's jobs rather than whichever profile ran last.
  setRunCaptureScope(value?.id ?? "");
  if (value) {
    // Seed the page empty rather than letting the first stamp inherit whatever
    // is still in the live map: the outgoing profile's rows are not cleared
    // until this profile's `runPipeline` calls `resetProgress`, and a profile
    // the singleton guard rejects never gets that far.
    profileRunStats.set(value.index, { profile: value, sourceStats: [] });
  }
}

/**
 * Update the current progress and notify all listeners.
 */
export function updateProgress(update: Partial<PipelineProgress>): void {
  const sourceStats = buildSourceStats();
  const page = statsPageProfile();
  if (page) {
    profileRunStats.set(page.index, {
      profile: page,
      sourceStats,
    });
  }
  currentProgress = {
    ...currentProgress,
    ...update,
    sourceStats,
    profileRun: activeProfileRun,
    profileRuns: buildProfileRunStats(),
  };

  // Notify all listeners
  for (const listener of listeners) {
    try {
      listener(currentProgress);
    } catch (error) {
      logger.error("Error in progress listener", error);
    }
  }
}

/**
 * Get the current progress state.
 */
export function getProgress(): PipelineProgress {
  return { ...currentProgress };
}

/**
 * Subscribe to progress updates.
 */
export function subscribeToProgress(listener: ProgressListener): () => void {
  listeners.add(listener);

  // Send current state immediately
  listener(currentProgress);

  // Return unsubscribe function
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reset progress to idle state.
 */
export function resetProgress(options?: {
  preserveSourceStats?: boolean;
}): void {
  // `crawlingStatsBySource` is ephemeral live-crawl telemetry (feeds the
  // aggregate "list pages / job pages" message), not the persisted funnel
  // rows, so it's always cleared — the re-run source re-seeds its own entry
  // in startSource. A per-source re-run preserves the funnel rows themselves
  // so the banner reconciles in place; the re-run sources self-reset on start.
  crawlingStatsBySource.clear();
  if (!options?.preserveSourceStats) {
    sourceStatsByPlatform.clear();
    sourceRowFallbackCounter = 0;
  }
  // A run outside a chain owns the whole banner, so it drops any pages an
  // earlier chain left behind. This must NOT fire for a run that belongs to a
  // page — a chain's profile (each resets its own live rows while the pages
  // accumulate) or a re-run aimed at one. Captured jobs go with the pages,
  // except on a per-source re-run, whose whole point is that the sources it
  // does not touch keep their rows AND their captures.
  if (statsPageProfile() === null && profileRunStats.size > 0) {
    profileRunStats.clear();
    if (!options?.preserveSourceStats) resetAllRunJobCaptures();
  }
  currentProgress = {
    step: "idle",
    message: "Ready",
    crawlingSource: null,
    crawlingSourcesCompleted: 0,
    crawlingSourcesTotal: 0,
    ...emptyCrawlingStats,
    jobsDiscovered: 0,
    jobsScored: 0,
    jobsProcessed: 0,
    totalToProcess: 0,
    sourceStats: options?.preserveSourceStats ? buildSourceStats() : [],
    // Stamped here too, not only in updateProgress: `subscribeToProgress`
    // replays `currentProgress` to every NEW subscriber, and this idle state is
    // what a mid-sequence re-subscribe would otherwise see — an untagged "idle"
    // that reads as "no run in progress" between two profiles.
    profileRun: activeProfileRun,
    profileRuns: buildProfileRunStats(),
  };
}

/**
 * Helper to create progress updates for each step.
 */
export const progressHelpers = {
  startCrawling: (
    sourcesTotal = 0,
    options?: { preserveSourceStats?: boolean },
  ) =>
    (() => {
      // On a per-source re-run, keep the existing funnel rows so other sources
      // stay on the banner; the re-run sources reset in startSource. Live
      // crawl telemetry is always cleared (see resetProgress).
      crawlingStatsBySource.clear();
      if (!options?.preserveSourceStats) {
        sourceStatsByPlatform.clear();
        sourceRowFallbackCounter = 0;
      }
      updateProgress({
        step: "crawling",
        message: "Fetching jobs from sources...",
        detail: "Starting crawler",
        startedAt: new Date().toISOString(),
        crawlingSource: null,
        crawlingSourcesCompleted: 0,
        crawlingSourcesTotal: sourcesTotal,
        ...emptyCrawlingStats,
        jobsDiscovered: 0,
        jobsScored: 0,
        jobsProcessed: 0,
        totalToProcess: 0,
      });
    })(),

  startSource: (
    source: CrawlSource,
    sourcesCompleted: number,
    sourcesTotal: number,
    options?: {
      termsTotal?: number;
      detail?: string;
      platforms?: string[];
      label?: string;
    },
  ) => {
    const existing =
      crawlingStatsBySource.get(source) ?? emptySourceCrawlingStats();
    crawlingStatsBySource.set(source, {
      ...emptySourceCrawlingStats(),
      termsTotal: options?.termsTotal ?? existing.termsTotal,
    });
    const aggregated = aggregateCrawlingStats();

    const platforms = options?.platforms ?? [source];
    // When an extractor groups multiple platforms (e.g. jobspy →
    // indeed/linkedin/glassdoor), suffix each row's label with `[<extractorId>]`
    // so the banner shows "LinkedIn [jobspy]" — keeps per-platform attribution
    // visible while making the underlying extractor obvious. 1:1 extractors
    // (hiringcafe / workingnomads / startupjobs) stay unsuffixed.
    const suffix = platforms.length > 1 ? ` [${source}]` : "";
    const startedAt = new Date().toISOString();
    for (const platform of platforms) {
      // A caller-supplied label (provider instances pass their user-set
      // display name) wins over the id-derived label; only the multi-platform
      // suffix logic falls back to the resolved extractor label.
      const baseLabel = options?.label ?? resolveSourceLabel(platform);
      const row = getOrCreateSourceRow(platform, `${baseLabel}${suffix}`);
      // (Re-)initialize the row when its source starts. On a full run the row
      // was just created at zero, so this is a no-op; on a per-source re-run
      // the row carries last run's terminal status + counts, so we reset it
      // (and drop its stale captures) to refresh in place.
      row.status = "running";
      row.startedAt = startedAt;
      row.completedAt = undefined;
      row.durationMs = undefined;
      row.error = undefined;
      row.jobsScraped = 0;
      row.jobsImported = 0;
      row.jobsReposted = 0;
      row.jobsDuplicated = 0;
      row.jobsUnmappable = 0;
      row.jobsFiltered = 0;
      row.jobsRejected = 0;
      resetRunJobCaptureForSource(platform);
    }

    updateProgress({
      step: "crawling",
      message: `Fetching jobs from ${source}...`,
      detail: options?.detail,
      crawlingSource: source,
      crawlingSourcesCompleted: sourcesCompleted,
      crawlingSourcesTotal: sourcesTotal,
      crawlingTermsProcessed: aggregated.termsProcessed,
      crawlingTermsTotal: aggregated.termsTotal,
      crawlingListPagesProcessed: aggregated.listPagesProcessed,
      crawlingListPagesTotal: aggregated.listPagesTotal,
      crawlingJobCardsFound: aggregated.jobCardsFound,
      crawlingJobPagesEnqueued: aggregated.jobPagesEnqueued,
      crawlingJobPagesSkipped: aggregated.jobPagesSkipped,
      crawlingJobPagesProcessed: aggregated.jobPagesProcessed,
      crawlingPhase: undefined,
      crawlingCurrentUrl: undefined,
    });
  },

  markSourceCompleted: (platform: string) => {
    const row = sourceStatsByPlatform.get(platform);
    if (!row) return;
    if (row.status !== "running" && row.status !== "pending") return;
    markRowTerminal(row, "completed");
    updateProgress({});
  },

  markSourceFailed: (platform: string, error: string) => {
    const row = getOrCreateSourceRow(platform);
    if (row.status === "completed" || row.status === "failed") return;
    markRowTerminal(row, "failed", error);
    updateProgress({});
  },

  recordSourceJobsCounts: (
    platform: string,
    counts: { scraped?: number; unmappable?: number },
  ) => {
    const row = sourceStatsByPlatform.get(platform);
    if (!row) return;
    if (counts.scraped !== undefined) row.jobsScraped = counts.scraped;
    if (counts.unmappable !== undefined) row.jobsUnmappable = counts.unmappable;
    updateProgress({});
  },

  recordSourceJobsFiltered: (platform: string, count: number) => {
    const row = getOrCreateSourceRow(platform);
    row.jobsFiltered = count;
    updateProgress({});
  },

  recordSourceJobsImported: (
    platform: string,
    counts: {
      imported: number;
      reposted: number;
      duplicated: number;
      rejected: number;
    },
  ) => {
    const row = getOrCreateSourceRow(platform);
    row.jobsImported = counts.imported;
    row.jobsReposted = counts.reposted;
    row.jobsDuplicated = counts.duplicated;
    row.jobsRejected = counts.rejected;
    updateProgress({});
  },

  completeSource: (sourcesCompleted: number, sourcesTotal: number) =>
    updateProgress({
      crawlingSourcesCompleted: sourcesCompleted,
      crawlingSourcesTotal: sourcesTotal,
      crawlingCurrentUrl: undefined,
      crawlingPhase: undefined,
    }),

  crawlingUpdate: (update: {
    source?: CrawlSource;
    termsProcessed?: number;
    termsTotal?: number;
    listPagesProcessed?: number;
    listPagesTotal?: number;
    jobCardsFound?: number;
    jobPagesEnqueued?: number;
    jobPagesSkipped?: number;
    jobPagesProcessed?: number;
    phase?: "list" | "job";
    currentUrl?: string;
  }) => {
    const current = getProgress();
    if (update.source) {
      const existing =
        crawlingStatsBySource.get(update.source) ?? emptySourceCrawlingStats();
      const nextForSource: SourceCrawlingStats = {
        termsProcessed: update.termsProcessed ?? existing.termsProcessed,
        termsTotal: update.termsTotal ?? existing.termsTotal,
        listPagesProcessed:
          update.listPagesProcessed ?? existing.listPagesProcessed,
        listPagesTotal: update.listPagesTotal ?? existing.listPagesTotal,
        jobCardsFound: update.jobCardsFound ?? existing.jobCardsFound,
        jobPagesEnqueued: update.jobPagesEnqueued ?? existing.jobPagesEnqueued,
        jobPagesSkipped: update.jobPagesSkipped ?? existing.jobPagesSkipped,
        jobPagesProcessed:
          update.jobPagesProcessed ?? existing.jobPagesProcessed,
      };
      crawlingStatsBySource.set(update.source, nextForSource);

      // Mirror live counters into the matching platform row, if one exists.
      // For 1:1 extractors (hiringcafe, workingnomads, …) source-key equals
      // the platform id, so the table updates live. For jobspy (source-key
      // "jobspy") no row matches and this is a no-op.
      const platformRow = sourceStatsByPlatform.get(update.source);
      if (
        platformRow &&
        (platformRow.status === "pending" || platformRow.status === "running")
      ) {
        platformRow.jobsScraped = nextForSource.jobPagesProcessed;
      }
    }

    const aggregated = aggregateCrawlingStats();
    const next = {
      ...current,
      crawlingSource: update.source ?? current.crawlingSource,
      crawlingTermsProcessed: update.source
        ? aggregated.termsProcessed
        : (update.termsProcessed ?? current.crawlingTermsProcessed),
      crawlingTermsTotal: update.source
        ? aggregated.termsTotal
        : (update.termsTotal ?? current.crawlingTermsTotal),
      crawlingListPagesProcessed: update.source
        ? aggregated.listPagesProcessed
        : (update.listPagesProcessed ?? current.crawlingListPagesProcessed),
      crawlingListPagesTotal: update.source
        ? aggregated.listPagesTotal
        : (update.listPagesTotal ?? current.crawlingListPagesTotal),
      crawlingJobCardsFound: update.source
        ? aggregated.jobCardsFound
        : (update.jobCardsFound ?? current.crawlingJobCardsFound),
      crawlingJobPagesEnqueued: update.source
        ? aggregated.jobPagesEnqueued
        : (update.jobPagesEnqueued ?? current.crawlingJobPagesEnqueued),
      crawlingJobPagesSkipped: update.source
        ? aggregated.jobPagesSkipped
        : (update.jobPagesSkipped ?? current.crawlingJobPagesSkipped),
      crawlingJobPagesProcessed: update.source
        ? aggregated.jobPagesProcessed
        : (update.jobPagesProcessed ?? current.crawlingJobPagesProcessed),
      crawlingPhase: update.phase ?? current.crawlingPhase,
      crawlingCurrentUrl: update.currentUrl ?? current.crawlingCurrentUrl,
    };

    const sourcesPart =
      next.crawlingListPagesTotal > 0
        ? `${next.crawlingListPagesProcessed}/${next.crawlingListPagesTotal}`
        : `${next.crawlingListPagesProcessed}`;

    const pagesPart = `${next.crawlingJobPagesProcessed}/${next.crawlingJobPagesEnqueued}`;
    const termsPart =
      next.crawlingTermsTotal > 0
        ? `, terms ${next.crawlingTermsProcessed}/${next.crawlingTermsTotal}`
        : "";
    const skippedPart =
      next.crawlingJobPagesSkipped > 0
        ? `, skipped ${next.crawlingJobPagesSkipped}`
        : "";
    const cardsPart =
      next.crawlingJobCardsFound > 0
        ? `, cards ${next.crawlingJobCardsFound}`
        : "";

    const message = `Crawling jobs (list pages ${sourcesPart}, job pages ${pagesPart}${termsPart}${skippedPart}${cardsPart})...`;
    const detail =
      next.crawlingCurrentUrl && next.crawlingPhase
        ? `${next.crawlingPhase === "list" ? "List" : "Job"}: ${next.crawlingCurrentUrl}`
        : next.crawlingCurrentUrl
          ? next.crawlingCurrentUrl
          : "Running crawler";

    updateProgress({
      step: "crawling",
      message,
      detail,
      crawlingSource: next.crawlingSource,
      crawlingTermsProcessed: next.crawlingTermsProcessed,
      crawlingTermsTotal: next.crawlingTermsTotal,
      crawlingListPagesProcessed: next.crawlingListPagesProcessed,
      crawlingListPagesTotal: next.crawlingListPagesTotal,
      crawlingJobCardsFound: next.crawlingJobCardsFound,
      crawlingJobPagesEnqueued: next.crawlingJobPagesEnqueued,
      crawlingJobPagesSkipped: next.crawlingJobPagesSkipped,
      crawlingJobPagesProcessed: next.crawlingJobPagesProcessed,
      crawlingPhase: next.crawlingPhase,
      crawlingCurrentUrl: next.crawlingCurrentUrl,
    });
  },

  crawlingComplete: (jobsFound: number) =>
    updateProgress({
      step: "importing",
      message: `Found ${jobsFound} jobs, importing to database...`,
      detail: "Deduplicating and saving",
      jobsDiscovered: jobsFound,
      crawlingSource: null,
      crawlingCurrentUrl: undefined,
    }),

  importComplete: (created: number, skipped: number) =>
    updateProgress({
      step: "scoring",
      message: `Imported ${created} new jobs (${skipped} duplicates). Scoring...`,
      detail: "Using AI to evaluate job fit",
    }),

  scoringJob: (index: number, total: number, title: string) =>
    updateProgress({
      step: "scoring",
      message: `Scoring jobs (${index}/${total})...`,
      detail: title,
      jobsScored: index,
    }),

  scoringComplete: (totalScored: number) =>
    updateProgress({
      step: "scoring",
      message: `Scored ${totalScored} jobs.`,
      detail: "Ready for manual processing",
      jobsScored: totalScored,
      totalToProcess: 0,
      jobsProcessed: 0,
      currentJob: undefined,
    }),

  processingJob: (
    index: number,
    total: number,
    job: { id: string; title: string; employer: string },
  ) =>
    updateProgress({
      step: "processing",
      message: `Processing job ${index}/${total}...`,
      detail: `${job.title} @ ${job.employer}`,
      totalToProcess: total,
      currentJob: job,
    }),

  generatingSummary: (job: { title: string; employer: string }) =>
    updateProgress({
      detail: `Generating summary for ${job.title}...`,
    }),

  generatingPdf: (job: { title: string; employer: string }) =>
    updateProgress({
      detail: `Generating PDF for ${job.title}...`,
    }),

  jobComplete: (index: number, total: number) =>
    updateProgress({
      jobsProcessed: index,
      detail: `Completed ${index}/${total} jobs`,
    }),

  complete: (discovered: number, processed: number) => {
    sweepInFlightRows("completed");
    updateProgress({
      step: "completed",
      message: `Pipeline complete! Discovered ${discovered} jobs, processed ${processed}.`,
      detail: "Ready for review",
      completedAt: new Date().toISOString(),
      currentJob: undefined,
    });
  },

  cancelled: (reason: string) => {
    sweepInFlightRows("failed", reason);
    updateProgress({
      step: "cancelled",
      message: "Pipeline cancelled",
      detail: reason,
      completedAt: new Date().toISOString(),
      currentJob: undefined,
    });
  },

  failed: (error: string) => {
    sweepInFlightRows("failed", error);
    updateProgress({
      step: "failed",
      message: "Pipeline failed",
      detail: error,
      error,
      completedAt: new Date().toISOString(),
    });
  },

  /**
   * The single terminal a multi-profile sequence emits for the WHOLE chain,
   * after clearing the active-profile context so it arrives untagged. `status`
   * is restricted to the three real terminal steps: the client drops any event
   * whose step it doesn't know, and an invented one would leave the run
   * hanging forever with no toast.
   */
  sequenceFinished: (args: {
    status: "completed" | "cancelled" | "failed";
    message: string;
    detail: string;
    error?: string;
  }) => {
    sweepInFlightRows(args.status === "completed" ? "completed" : "failed");
    updateProgress({
      step: args.status,
      message: args.message,
      detail: args.detail,
      error: args.error,
      completedAt: new Date().toISOString(),
      currentJob: undefined,
    });
  },
};

function sweepInFlightRows(
  status: "completed" | "failed",
  error?: string,
): void {
  for (const row of sourceStatsByPlatform.values()) {
    if (row.status === "pending" || row.status === "running") {
      markRowTerminal(row, status, error);
    }
  }
}
