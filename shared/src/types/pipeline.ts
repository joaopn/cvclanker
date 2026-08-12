import type { ExtractorSourceId } from "../extractors";
import type {
  LocationMatchStrictness,
  LocationSearchScope,
} from "../location-preferences";
import type { Job, JobOutcome, JobStatus, SuitabilityCategory } from "./jobs";
import type { LocationIntent } from "./location";

export interface PipelineConfig {
  topN: number; // Number of top jobs to process
  minSuitabilityCategory: SuitabilityCategory; // Minimum category to auto-process
  sources?: ExtractorSourceId[]; // Optional per-run override; otherwise uses enabled sources from source_configs
  // Optional per-run override for marketplace provider instances (Apify, …).
  // `undefined` = all enabled instances run; `[]` = none; a list = only those
  // instance ids. Mirrors the undefined-vs-empty semantics of `sources`.
  providerInstanceIds?: string[];
  maxJobsPerTerm?: number; // Per-run cap that overrides each source's stored max_jobs_per_term
  // Per-source re-run: reconcile this run's sources into the existing banner
  // funnel instead of wiping every source's results. Untouched sources keep
  // their rows + captured jobs; only the re-run sources refresh.
  partial?: boolean;
  outputDir: string; // Directory for generated PDFs
  locationIntent?: LocationIntent;
  // Scrape config the selected Profile drives (Batch 3). When set, these win
  // over the global `settings` values; when absent, discover-jobs falls back
  // to settings so no-profile / transitional runs keep working.
  searchTerms?: string[];
  scrapeMaxAgeDays?: number | null;
  // The Search Profile backing this run. Identifies the scrape watermarks the
  // "since last run" window is measured against; absent for body-only runs
  // (no profile), where the feature is inert.
  profileId?: string;
  scrapeSinceLastRun?: boolean;
  blockedCompanyKeywords?: string[];
  enableCrawling?: boolean;
  enableScoring?: boolean;
  enableImporting?: boolean;
  enableAutoTailoring?: boolean;
}

export interface PipelineRunConfigSnapshot {
  topN: number;
  minSuitabilityCategory: SuitabilityCategory;
  sources: ExtractorSourceId[];
  locationIntent: LocationIntent;
}

export interface PipelineRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  jobsDiscovered: number;
  jobsProcessed: number;
  errorMessage: string | null;
  configSnapshot?: PipelineRunConfigSnapshot | null;
}

export type PipelineRunExecutionStage =
  | "started"
  | "profile_loaded"
  | "discovery"
  | "import"
  | "scoring"
  | "selection"
  | "processing"
  | "completed";

export interface PipelineRunRequestedConfig {
  topN: number;
  minSuitabilityCategory: SuitabilityCategory;
  sources: ExtractorSourceId[];
  enableCrawling: boolean;
  enableScoring: boolean;
  enableImporting: boolean;
  enableAutoTailoring: boolean;
}

export interface PipelineRunSourceLimitSnapshot {
  maxJobsPerTerm: number | null;
}

export interface PipelineRunModelSnapshot {
  scorer: string;
  tailoring: string;
}

export interface PipelineRunSkippedSource {
  source: ExtractorSourceId;
  reason: string;
}

export interface PipelineRunEffectiveConfig {
  country: string | null;
  countryLabel: string | null;
  searchCities: string[];
  searchTermsCount: number;
  workplaceTypes: Array<"remote" | "hybrid" | "onsite">;
  locationSearchScope: LocationSearchScope;
  locationMatchStrictness: LocationMatchStrictness;
  compatibleSources: ExtractorSourceId[];
  skippedSources: PipelineRunSkippedSource[];
  blockedCompanyKeywordsCount: number;
  sourceLimits: PipelineRunSourceLimitSnapshot;
  autoSkipCategory: SuitabilityCategory | null;
  models: PipelineRunModelSnapshot;
}

export interface PipelineRunResultSummary {
  stage: PipelineRunExecutionStage;
  jobsScored: number | null;
  jobsSelected: number | null;
  sourceErrors: string[];
}

export interface PipelineRunSavedDetails {
  requestedConfig: PipelineRunRequestedConfig;
  effectiveConfig: PipelineRunEffectiveConfig;
  resultSummary: PipelineRunResultSummary;
}

export interface PipelineStatusResponse {
  isRunning: boolean;
  lastRun: PipelineRun | null;
  nextScheduledRun: string | null;
}

export type PipelineSourceStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface PipelineSourceStats {
  id: string;
  label: string;
  status: PipelineSourceStatus;
  jobsScraped: number; // all jobs returned by the source after mapping
  jobsImported: number; // brand-new rows inserted
  jobsReposted: number; // existing rows re-promoted from a shelf (folded into "imported" in the UI)
  jobsDuplicated: number; // existing rows that stayed put (deduped at import)
  jobsFiltered: number; // dropped before import (location-intent mismatch / blocked company)
  jobsRejected: number; // rows dropped at import (e.g. unparseable date_posted)
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
}

/**
 * The four per-source funnel buckets surfaced in the run banner. Each maps to
 * a clickable count whose jobs are captured in-memory during the run (they
 * aren't all persisted — duplicates collide with existing rows, rejected jobs
 * are dropped — so they can't be reconstructed from the DB after the fact).
 */
export type RunJobBucket = "scraped" | "imported" | "duplicated" | "rejected";

export const RUN_JOB_BUCKETS: readonly RunJobBucket[] = [
  "scraped",
  "imported",
  "duplicated",
  "rejected",
];

/** A lightweight job record captured during a run for the per-bucket popup. */
export interface CapturedRunJob {
  title: string;
  employer: string;
  jobUrl: string;
  applicationLink?: string;
  employerUrl?: string;
  location?: string;
  datePosted?: string;
  deadline?: string;
  salary?: string;
  jobType?: string;
  jobLevel?: string;
  jobFunction?: string;
  isRemote?: boolean;
  reason?: string; // why a "rejected" job dropped (e.g. location / blocked / bad data)
}

export interface RunJobsResponse {
  source: string;
  bucket: RunJobBucket;
  jobs: CapturedRunJob[];
}

export type PipelineProgressStep =
  | "idle"
  | "crawling"
  | "importing"
  | "scoring"
  | "processing"
  | "completed"
  | "cancelled"
  | "failed";

export interface PipelineProgressEvent {
  step: PipelineProgressStep;
  message: string;
  detail?: string;
  crawlingSource: string | null;
  crawlingSourcesCompleted: number;
  crawlingSourcesTotal: number;
  crawlingTermsProcessed: number;
  crawlingTermsTotal: number;
  crawlingListPagesProcessed: number;
  crawlingListPagesTotal: number;
  crawlingJobCardsFound: number;
  crawlingJobPagesEnqueued: number;
  crawlingJobPagesSkipped: number;
  crawlingJobPagesProcessed: number;
  crawlingPhase?: "list" | "job";
  crawlingCurrentUrl?: string;
  jobsDiscovered: number;
  jobsScored: number;
  jobsProcessed: number;
  totalToProcess: number;
  currentJob?: {
    id: string;
    title: string;
    employer: string;
  };
  error?: string;
  startedAt?: string;
  completedAt?: string;
  sourceStats: PipelineSourceStats[];
  /**
   * Set on every event emitted while a multi-profile sequence is running, and
   * null otherwise — including on the single aggregate terminal the sequence
   * emits when the chain ends. Consumers read it as "this event belongs to one
   * profile of a chain, so it is not the chain's own start or end". `index` is
   * 1-based.
   */
  profileRun?: PipelineProfileRun | null;
}

export interface PipelineProfileRun {
  id: string;
  name: string;
  index: number;
  total: number;
}

export type PipelineMetricQuality =
  | "exact"
  | "inferred_from_timestamps"
  | "unavailable";

export interface PipelineRunMetric<T = number | null> {
  value: T;
  quality: PipelineMetricQuality;
}

export interface PipelineRunInsights {
  run: PipelineRun;
  exactMetrics: {
    durationMs: number | null;
  };
  savedDetails: PipelineRunSavedDetails | null;
  inferredMetrics: {
    jobsCreated: PipelineRunMetric<number | null>;
    jobsUpdated: PipelineRunMetric<number | null>;
    jobsProcessed: PipelineRunMetric<number | null>;
  };
}

export interface JobsListResponse<TJob = Job> {
  jobs: TJob[];
  total: number;
  byStatus: Record<JobStatus, number>;
  revision: string;
}

export interface JobsRevisionResponse {
  revision: string;
  latestUpdatedAt: string | null;
  total: number;
  statusFilter: string | null;
}

export type JobAction =
  | "skip"
  | "move_to_ready"
  | "rescore"
  | "clear_score"
  | "rescrape"
  | "move_to_backlog"
  | "move_to_stale"
  | "move_to_inbox"
  | "mark_closed"
  | "mark_duplicated"
  | "reopen";

export type JobActionRequest =
  | {
      action:
        | "skip"
        | "rescore"
        | "clear_score"
        | "rescrape"
        | "move_to_backlog"
        | "move_to_stale"
        | "move_to_inbox"
        | "mark_duplicated"
        | "reopen";
      jobIds: string[];
    }
  | {
      action: "move_to_ready";
      jobIds: string[];
      options?: {
        force?: boolean;
      };
    }
  | {
      action: "mark_closed";
      jobIds: string[];
      options: {
        outcome: JobOutcome;
      };
    };

export type JobActionResult =
  | {
      jobId: string;
      ok: true;
      job: Job;
    }
  | {
      jobId: string;
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export interface JobActionResponse {
  action: JobAction;
  requested: number;
  succeeded: number;
  failed: number;
  results: JobActionResult[];
}

export type LlmCallStatus = "running" | "succeeded" | "failed";

export interface LlmCallRecord {
  id: string;
  label: string;
  /** Optional secondary line — typically "Job Title @ Employer". */
  subject: string | null;
  model: string;
  status: LlmCallStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  /**
   * Provider-reported prompt + completion tokens. Null while the call is
   * running, when it failed, when the provider exposes no usage at all
   * (Codex), or when it reports a zeroed usage block — never estimated
   * locally.
   */
  totalTokens: number | null;
  jobId: string | null;
  errorMessage: string | null;
}

export type LlmCallStreamEvent =
  | { type: "snapshot"; calls: LlmCallRecord[]; requestId: string }
  | { type: "update"; call: LlmCallRecord; requestId: string };

export interface BatchUrlImportTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  totalMillions: number | null;
}

export type BatchUrlImportItemResult =
  | {
      ok: true;
      status: "created" | "duplicate";
      url: string;
      jobId: string;
      title: string;
      employer: string;
      usage?: BatchUrlImportTokenUsage | null;
    }
  | {
      ok: false;
      status: "failed";
      url: string;
      code: string;
      message: string;
      usage?: BatchUrlImportTokenUsage | null;
    };

export type BatchUrlImportStreamEvent =
  | {
      type: "started";
      requested: number;
      requestId: string;
    }
  | {
      type: "progress";
      result: BatchUrlImportItemResult;
      completed: number;
      succeeded: number;
      duplicates: number;
      failed: number;
      requestId: string;
    }
  | {
      type: "completed";
      results: BatchUrlImportItemResult[];
      succeeded: number;
      duplicates: number;
      failed: number;
      requestId: string;
    }
  | {
      type: "error";
      code: string;
      message: string;
      requestId: string;
    };

export type JobActionStreamEvent =
  | {
      type: "started";
      action: JobAction;
      requested: number;
      completed: number;
      succeeded: number;
      failed: number;
      requestId: string;
    }
  | {
      type: "progress";
      action: JobAction;
      requested: number;
      completed: number;
      succeeded: number;
      failed: number;
      result: JobActionResult;
      requestId: string;
    }
  | {
      type: "completed";
      action: JobAction;
      requested: number;
      completed: number;
      succeeded: number;
      failed: number;
      results: JobActionResult[];
      requestId: string;
    }
  | {
      type: "error";
      code: string;
      message: string;
      requestId: string;
    };
