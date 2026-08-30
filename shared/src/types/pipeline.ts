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
  // Per-run override of the `discoveryConcurrency` setting: how many sources
  // crawl at once. A "retry all failed" re-run sends 1 — one source at a time.
  discoveryConcurrency?: number;
  outputDir: string; // Directory for generated PDFs
  locationIntent?: LocationIntent;
  // Scrape config the selected Profile drives (Batch 3). When set, these win
  // over the global `settings` values; when absent, discover-jobs falls back
  // to settings so no-profile / transitional runs keep working.
  searchTerms?: string[];
  /**
   * The profile's configured max job age, in days. Under the run menu this is a
   * CEILING as well as the default window: a run asking for more is refused
   * outright rather than clamped, so "the run scraped less than I asked" is
   * never a silent outcome.
   */
  scrapeMaxAgeDays?: number | null;
  /**
   * An explicit per-run window, in days, overriding both the profile's default
   * window and the "since last run" narrowing. Never wider than
   * `scrapeMaxAgeDays` — the run route refuses the request instead.
   */
  scrapeWindowDays?: number;
  // The Search Profile backing this run. Identifies the scrape watermarks the
  // "since last run" window is measured against; absent for body-only runs
  // (no profile), where the feature is inert.
  profileId?: string;
  scrapeSinceLastRun?: boolean;
  /**
   * Per-run override of the `liveStatusRefreshEnabled` setting: re-read the
   * live LinkedIn status of rows already in the database as part of this run.
   * Absent falls through to the setting.
   */
  refreshLiveStatus?: boolean;
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
  | "live_status"
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
  /**
   * The window this run asked its sources for, in days, and whether it was
   * narrowed per source from the scrape watermarks. Optional because runs saved
   * before the window became per-run carry neither — without them a past run's
   * coverage cannot be reconstructed from its own record.
   */
  maxAgeDays?: number | null;
  scrapeSinceLastRun?: boolean;
}

export interface PipelineRunModelSnapshot {
  scorer: string;
  tailoring: string;
  /**
   * The cheap model that screened bad fits out before the scorer saw them, or
   * "" when the run did not use one. Optional because runs saved before
   * two-stage scoring existed carry no such field.
   */
  scorerPrefilter?: string;
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
  /** Which partition the in-flight run belongs to; null when nothing runs. */
  runningTrigger: RunTrigger | null;
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
  jobsUnmappable: number; // items the source returned that never became jobs (mapper could not read them)
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
  // Re-reading the live LinkedIn status of rows already in the database. Sits
  // between scoring and selection, and only when the run opted in.
  | "live_status"
  | "processing"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * What started a run.
 *
 * Manual and scheduled runs keep SEPARATE progress state server-side: each has
 * its own retained funnel, dismissed independently, showing only its own latest
 * run. The pipeline is still a singleton, so the two are separated in space and
 * never in time — only one run of either kind is ever in flight.
 */
export const RUN_TRIGGERS = ["manual", "schedule"] as const;

export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export interface PipelineProgressEvent {
  step: PipelineProgressStep;
  message: string;
  detail?: string;
  /**
   * Which partition this event belongs to. Required rather than optional so
   * every construction site has to say, and so a consumer that must not mix the
   * two has something to filter on.
   */
  trigger: RunTrigger;
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
  /**
   * Live-status refresh counters. Their own fields rather than borrowed ones:
   * `jobsScored` and `totalToProcess` belong to the steps either side of this
   * one, and writing them here would rewrite numbers the banner has already
   * shown. Optional because only a run that opted in ever sets them.
   */
  liveStatusChecked?: number;
  liveStatusTotal?: number;
  currentJob?: {
    id: string;
    title: string;
    employer: string;
  };
  error?: string;
  startedAt?: string;
  completedAt?: string;
  /**
   * Whether someone has dismissed this run's banner.
   *
   * Server-side, so it is a property of the RUN rather than of one browser:
   * dismiss it in one tab and every tab hides it, and reopening the page does
   * not resurrect a banner already dealt with. Cleared when the next run
   * starts, since that banner has not been dismissed by anyone.
   */
  dismissed: boolean;
  sourceStats: PipelineSourceStats[];
  /**
   * Set on every event emitted while a multi-profile sequence is running, and
   * null otherwise — including on the single aggregate terminal the sequence
   * emits when the chain ends. Consumers read it as "this event belongs to one
   * profile of a chain, so it is not the chain's own start or end". `index` is
   * 1-based.
   */
  profileRun?: PipelineProfileRun | null;
  /**
   * One page of funnel rows per profile a multi-profile chain has reached, in
   * run order. `sourceStats` only ever holds the CURRENT profile's rows —
   * every profile resets them — so without this the banner would end a chain
   * showing nothing but the last profile's results. Empty for a single run.
   */
  profileRuns?: PipelineProfileRunStats[];
}

export interface PipelineProfileRun {
  id: string;
  name: string;
  index: number;
  total: number;
}

/** One profile's funnel rows, retained after the chain moves on to the next. */
export interface PipelineProfileRunStats {
  profile: PipelineProfileRun;
  sourceStats: PipelineSourceStats[];
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
  | "reopen"
  // Refreshes the row's live LinkedIn status (still accepting applications +
  // applicant-count caption) from the public guest endpoint. LinkedIn rows
  // only; touches no status/score/tailoring field.
  | "fetch_live_status"
  // Irreversible: removes the row and everything hanging off it. Deliberately
  // absent from the client's `undoActionLabel` — undo restores {status,
  // outcome, closedAt} via PATCH, which cannot bring a deleted row back.
  | "delete"
  // Re-tailors an ALREADY-TAILORED (`ready`) row against the currently active
  // CV document — the bulk form of the per-job "Generate" button. Re-running
  // the tailoring LLM rather than just re-rendering the PDF is what makes a CV
  // template change land: CV field ids are LLM-authored and nothing pins them
  // across extractions, so stored `tailoredFields` keyed on ids the new
  // template renamed are silently dropped at render time (and if ALL of them
  // die the baseline guard hard-fails the render). Also absent from
  // `undoActionLabel` — a PATCH cannot restore overwritten tailoredFields.
  | "retailor";

export type JobActionRequest =
  | {
      action:
        | "skip"
        | "clear_score"
        | "rescrape"
        | "move_to_backlog"
        | "move_to_stale"
        | "move_to_inbox"
        | "mark_duplicated"
        | "reopen"
        | "fetch_live_status"
        | "delete"
        | "retailor";
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
      action: "rescore";
      jobIds: string[];
      options?: {
        /**
         * Opt this request into the cheap pre-filter. Omitted — the default for
         * every manual rescore — goes straight to the scoring model, which is
         * what keeps a manual rescore a genuine second opinion on anything the
         * screen removed. The UI offers it as its own button, so a screened
         * rescore is always something the user asked for by name.
         */
        prefilter?: boolean;
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

/**
 * Cap on one pasted import. Shared because the client renders it in its own
 * copy ("up to N at a time") and the server enforces it — two literals that
 * would drift into a form promising more than the route accepts.
 */
export const BATCH_URL_IMPORT_MAX_URLS = 50;

/**
 * A URL import running detached from any browser.
 *
 * Unlike a job-action batch this DOES carry its per-item results, because the
 * import sheet's whole surface is a row per URL saying imported / duplicate /
 * failed-and-why — a second device that could only see counters could not
 * render it. That is affordable here and was not there: a job-action result
 * embeds a whole `Job` and its cap is 1000, while these are a few short fields
 * capped at 50.
 */
export interface UrlImportBatchSnapshot {
  batchId: string;
  status: JobActionBatchStatus;
  /**
   * Every URL the import was asked for, deduped, in the order the server took
   * them. Load-bearing, not decoration: the sheet CREATES its rows from this
   * list and MATCHES results onto them, so a client attaching at 10/50 would
   * otherwise render ten rows and retry against a truncated list.
   */
  urls: string[];
  /** Settled items, rebuilt in request order. */
  results: BatchUrlImportItemResult[];
  requested: number;
  completed: number;
  succeeded: number;
  duplicates: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * One import at a time, so the viewer carries one record rather than a
 * registry. `batch: null` means no import is retained at all.
 */
export type UrlImportBatchStreamEvent =
  | {
      type: "snapshot";
      batch: UrlImportBatchSnapshot | null;
      requestId: string;
    }
  | {
      type: "update";
      batch: UrlImportBatchSnapshot;
      requestId: string;
    };

export const MAX_RETAINED_TERMINAL_BATCHES = 50;

export type JobActionBatchStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Counters-only view of a bulk action running detached from any browser.
 *
 * Deliberately carries no `Job` payloads. `JobActionResult` embeds a whole
 * `Job` on success and `maxBulkActionJobs` defaults to 1000, while every
 * attached tab receives every batch's events — today only the one initiating
 * request did. The stream's consumers only ever read ok flags, job ids and
 * error messages, so the full rows would be pure broadcast weight.
 */
export interface JobActionBatchSnapshot {
  batchId: string;
  action: JobAction;
  status: JobActionBatchStatus;
  requested: number;
  /**
   * Dispatched and settled. MAY stop short of `requested` on a cancel — the
   * pool is stopped between dispatches, so undispatched items are dropped —
   * but a cancel arriving while the last tasks are in flight still settles at
   * `completed === requested`. Never assume cancelled implies a shortfall.
   */
  completed: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  /**
   * Bounded by `failed`, not `requested`. The tab that STARTED the batch needs
   * these after any reconnect, for two things the counters cannot supply: the
   * undo set, and the selection reconciliation that keeps failed rows selected
   * for retry.
   */
  failedJobIds: string[];
  firstFailureMessage: string | null;
}

/** Slim per-job outcome — the counters-only stream's replacement for JobActionResult. */
export interface JobActionBatchItemOutcome {
  jobId: string;
  ok: boolean;
  errorMessage: string | null;
}

/**
 * Multiplexed viewer feed: one connection carries every batch, so each event
 * names its batch. `snapshot` is the COMPLETE enumeration of retained batches,
 * which is what lets a client treat absence as meaningful — a batch that
 * vanishes without ever going terminal was lost with the process.
 */
export type JobActionBatchStreamEvent =
  | {
      type: "snapshot";
      batches: JobActionBatchSnapshot[];
      requestId: string;
    }
  | {
      type: "progress";
      batch: JobActionBatchSnapshot;
      lastResult: JobActionBatchItemOutcome;
      requestId: string;
    }
  | {
      type: "terminal";
      batch: JobActionBatchSnapshot;
      requestId: string;
    };

/** How a source treats the run's requested scrape window. */
export type RunWindowSupport =
  /** The run's window reaches it and bounds what it fetches. */
  | "run_window"
  /**
   * It honours a max job age, but its own (Sources page) rather than the run's
   * — the `maxAgeDays` global mapping is unticked, so the run never reaches it.
   */
  | "own_max_age"
  /** It has no max-age concept at all and returns its whole feed. */
  | "ignores";

/** One selectable source in the run menu. */
export interface RunOptionSource {
  /** Discovery task id: extractor manifest id, or `<provider>:<instance>`. */
  key: string;
  kind: "extractor" | "provider_instance";
  label: string;
  /**
   * The platform ids to send as `sources` when this task is selected, filtered
   * to those compatible with the profile's location setup. Empty for a provider
   * instance (those go in `providerInstanceIds` instead) and for a task nothing
   * of which can run.
   */
  platforms: ExtractorSourceId[];
  /** Platforms this profile's location setup rules out, with the reason. */
  incompatible: Array<{ platform: string; reasons: string[] }>;
  /** When this source last scraped successfully for the profile. */
  lastScrapedAt: string | null;
  /** Widest window this source will accept, in days; null = uncapped. */
  capDays: number | null;
  windowSupport: RunWindowSupport;
  /** Fixed windows the source snaps a request onto, if any. */
  maxAgeBuckets: number[] | null;
  /** One sentence on what this source does with a max job age. */
  note: string | null;
}

/** Everything the run menu needs to offer a scoped run, for one Profile or a chain. */
export interface RunOptionsResponse {
  /**
   * The Profiles these options describe — the default one when none was asked
   * for. Several means a chain, and the fields below are merged across them.
   */
  profileIds: string[];
  sources: RunOptionSource[];
  /** The Profile's configured max job age; null = no ceiling configured. */
  capDays: number | null;
  /** Which window mode the menu should open on. */
  defaultSinceLastRun: boolean;
  /**
   * Whether the live-status tickbox opens ticked — the standing
   * `liveStatusRefreshEnabled` setting, which is also what a Run pressed
   * somewhere without this menu (the Swipe page) uses.
   */
  defaultRefreshLiveStatus: boolean;
  /** How many rows one run would check, so the menu can price the option. */
  liveStatusRefreshLimit: number;
  /**
   * How long a check stays fresh, in hours. The menu names it because it
   * decides how much of that cap a repeat run actually spends. 0 = no floor.
   */
  liveStatusRefreshMinAgeHours: number;
}
