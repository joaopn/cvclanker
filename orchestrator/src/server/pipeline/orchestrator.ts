/**
 * Main pipeline logic - orchestrates the daily job processing flow.
 *
 * Flow:
 * 1. Run crawler to discover new jobs
 * 2. Score jobs for suitability
 * 3. Leave all jobs in "discovered" for manual processing
 */

import { join } from "node:path";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { createLocationIntentFromLegacyInputs } from "@shared/location-domain.js";
import type { ScrapedSourceMark } from "@shared/scrape-window.js";
import type {
  PipelineConfig,
  PipelineRunSavedDetails,
  RunTrigger,
} from "@shared/types";
import { getDataDir } from "../config/dataDir";
import * as jobsRepo from "../repositories/jobs";
import * as pipelineRepo from "../repositories/pipeline";
import * as settingsRepo from "../repositories/settings";
import { recordScrapeWatermarks } from "../repositories/source-scrape-watermarks";
import { llmAdjustContent } from "../services/cv";
import { getActiveCvDocument } from "../services/cv-active";
import { generatePdf } from "../services/pdf";
import { getEffectiveSettings } from "../services/settings";
import {
  activeRunTrigger,
  progressHelpers,
  resetProgress,
  setActiveRunTrigger,
} from "./progress";
import {
  buildPipelineRunSavedDetails,
  createPipelineRunResultSummary,
  updatePipelineRunResultSummary,
} from "./run-details";
import { resetRunJobCapture } from "./run-job-capture";
import { isProfileSequenceActive } from "./sequence-state";
import {
  discoverJobsStep,
  importJobsStep,
  loadBriefStep,
  processJobsStep,
  refreshLiveStatusStep,
  scoreJobsStep,
  selectJobsStep,
} from "./steps";

const DEFAULT_CONFIG: PipelineConfig = {
  topN: 10,
  minSuitabilityCategory: "good_fit",
  // Keep Glassdoor opt-in via source picker/settings; do not enable by default.
  sources: ["indeed", "linkedin"],
  outputDir: join(getDataDir(), "pdfs"),
  enableCrawling: true,
  enableScoring: true,
  enableImporting: true,
  enableAutoTailoring: false,
};

/**
 * Persist the "last scraped" mark for every source that came back clean, so
 * the profile's next run can narrow its max-age window to the elapsed time.
 * Best-effort: a failed write only means the next run scrapes the full
 * configured window, which is the pre-flag behaviour.
 *
 * Recorded for EVERY run of a profile, not only "since last run" ones. This is
 * an efficiency choice, not a correctness one: gating on the flag would leave a
 * later narrowing measuring against a mark that ignores every run in between,
 * which is merely WIDER than it needs to be — a stale mark re-scrapes, it never
 * skips. Recording every run is what makes a daily narrow run cheap, and it is
 * only safe because each mark carries the window its source actually ran with.
 * Whether a given source's mark moves is `resolveWatermarkAdvance`'s call.
 */
async function advanceScrapeWatermarks(args: {
  config: PipelineConfig;
  scrapedSources: ScrapedSourceMark[];
  scrapeStartedAt: string;
}): Promise<void> {
  const { config, scrapedSources, scrapeStartedAt } = args;
  if (!config.profileId || scrapedSources.length === 0) return;
  try {
    await recordScrapeWatermarks(
      config.profileId,
      scrapedSources,
      scrapeStartedAt,
    );
  } catch (error) {
    logger.warn("Failed to record scrape watermarks", {
      profileId: config.profileId,
      error,
    });
  }
}

/**
 * Per-run override first, then the standing setting. Resolved here rather than
 * read inside the step so a run started from a surface with no Run menu (the
 * Swipe page's button, a bare API call) still honours the setting, and so the
 * decision is visible on `mergedConfig`.
 *
 * A PARTIAL run never refreshes, whatever either says. `partial` means "re-run
 * these sources into the banner funnel that is already there" — the two
 * re-run buttons send it with no other overrides, and a live-status sweep is
 * unrelated to the source being retried. Gated here rather than by having the
 * two client helpers send `false`, so a caller added later cannot forget.
 */
async function resolveLiveStatusRefresh(
  configValue: boolean | undefined,
  options: { partial: boolean },
): Promise<boolean> {
  if (options.partial) return false;
  if (typeof configValue === "boolean") return configValue;
  return (await getEffectiveSettings()).liveStatusRefreshEnabled.value;
}

async function resolveAutoTailoring(
  configValue: boolean | undefined,
): Promise<boolean> {
  if (typeof configValue === "boolean") return configValue;
  const raw = await settingsRepo.getSetting("autoTailoringEnabled");
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return false;
}

// Track if pipeline is currently running
let isPipelineRunning = false;
let activePipelineRunId: string | null = null;
let cancelRequestedAt: string | null = null;

function resolveLocationIntent(
  config: Partial<PipelineConfig>,
): NonNullable<PipelineConfig["locationIntent"]> {
  return createLocationIntentFromLegacyInputs(config.locationIntent ?? {});
}

class PipelineCancelledError extends Error {
  constructor(message = "Pipeline cancellation requested") {
    super(message);
    this.name = "PipelineCancelledError";
  }
}

function ensureNotCancelled(): void {
  if (cancelRequestedAt) {
    throw new PipelineCancelledError();
  }
}

/**
 * Run the full job discovery and processing pipeline.
 */
export async function runPipeline(
  config: Partial<PipelineConfig> = {},
  options: { trigger?: RunTrigger } = {},
): Promise<{
  success: boolean;
  jobsDiscovered: number;
  jobsProcessed: number;
  error?: string;
}> {
  if (isPipelineRunning) {
    return {
      success: false,
      jobsDiscovered: 0,
      jobsProcessed: 0,
      error: "Pipeline is already running",
    };
  }

  isPipelineRunning = true;
  activePipelineRunId = "pending";
  cancelRequestedAt = null;
  // Which partition this run's progress belongs to, established here — before
  // the first await, alongside the other run-start state, and BEFORE the resets
  // below, which act on whichever slot is active. Passed in rather than
  // inferred: read ambiently it would report whichever kind of run went last.
  setActiveRunTrigger(options.trigger ?? "manual");
  // A per-source re-run reconciles into the existing banner funnel: preserve
  // every other source's progress rows and captured jobs; only the re-run
  // sources reset (handled per-source as each one starts crawling).
  const partial = config.partial === true;
  resetProgress(partial ? { preserveSourceStats: true } : undefined);
  if (!partial) {
    resetRunJobCapture();
  }
  const locationIntent = resolveLocationIntent(config);
  const enableAutoTailoring = await resolveAutoTailoring(
    config.enableAutoTailoring,
  );
  const refreshLiveStatus = await resolveLiveStatusRefresh(
    config.refreshLiveStatus,
    { partial },
  );
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    enableAutoTailoring,
    refreshLiveStatus,
    locationIntent,
  };
  const configSnapshot = {
    topN: mergedConfig.topN,
    minSuitabilityCategory: mergedConfig.minSuitabilityCategory,
    sources: mergedConfig.sources ?? [],
    locationIntent,
  } as const;

  let savedDetails: PipelineRunSavedDetails | null = null;
  try {
    savedDetails = await buildPipelineRunSavedDetails(mergedConfig);
  } catch (error) {
    logger.warn("Failed to capture pipeline run settings snapshot", { error });
  }

  const pipelineRun = await pipelineRepo.createPipelineRun({
    configSnapshot,
    savedDetails,
  });
  activePipelineRunId = pipelineRun.id;

  return runWithRequestContext({ pipelineRunId: pipelineRun.id }, async () => {
    const pipelineLogger = logger.child({ pipelineRunId: pipelineRun.id });
    let jobsDiscovered = 0;
    let jobsProcessed = 0;
    let resultSummary =
      savedDetails?.resultSummary ?? createPipelineRunResultSummary();
    const persistResultSummary = async (
      update: Parameters<typeof updatePipelineRunResultSummary>[1],
    ) => {
      resultSummary = updatePipelineRunResultSummary(resultSummary, update);
      await pipelineRepo.updatePipelineRun(pipelineRun.id, {
        resultSummary,
      });
    };
    pipelineLogger.info("Starting pipeline run", {
      topN: mergedConfig.topN,
      minSuitabilityCategory: mergedConfig.minSuitabilityCategory,
      sources: mergedConfig.sources,
      locationIntent: mergedConfig.locationIntent,
    });

    try {
      ensureNotCancelled();
      await persistResultSummary({ stage: "started" });
      const brief = await loadBriefStep();
      await persistResultSummary({ stage: "profile_loaded" });

      ensureNotCancelled();
      await persistResultSummary({ stage: "discovery" });
      const { discoveredJobs, sourceErrors, scrapedSources, scrapeStartedAt } =
        await discoverJobsStep({
          mergedConfig,
          shouldCancel: () => cancelRequestedAt !== null,
        });
      await persistResultSummary({
        stage: "discovery",
        sourceErrors,
      });

      ensureNotCancelled();
      const { created, reposted, rejected } = await importJobsStep({
        discoveredJobs,
        profileId: mergedConfig.profileId,
      });
      jobsDiscovered = created;

      // Advanced only now: a source whose jobs were discovered but never
      // imported (crash, cancellation) must keep its old watermark, or the
      // next run's narrowed window skips straight past them.
      await advanceScrapeWatermarks({
        config: mergedConfig,
        scrapedSources,
        scrapeStartedAt,
      });

      await persistResultSummary({ stage: "import" });
      await pipelineRepo.updatePipelineRun(pipelineRun.id, {
        jobsDiscovered: created,
      });

      pipelineLogger.info("Import step finished", {
        created,
        reposted,
        rejected,
      });

      ensureNotCancelled();
      await persistResultSummary({ stage: "scoring" });
      const { scoredJobs } = await scoreJobsStep({
        brief,
        shouldCancel: () => cancelRequestedAt !== null,
      });
      await persistResultSummary({
        stage: "scoring",
        jobsScored: scoredJobs.length,
      });

      // Between scoring and selection: the run's expensive, failure-prone LLM
      // work is already done and persisted, so a LinkedIn stall costs it
      // nothing, and the verdicts are in the database before auto-tailoring
      // spends money on a posting. Note that selectJobsStep reads the
      // in-memory `scoredJobs` this run captured BEFORE the refresh, so a
      // future "do not tailor a closed posting" rule needs a re-read (or this
      // step returning the closed ids) — the ordering alone does not give it.
      // Best-effort by construction: the step catches everything.
      if (mergedConfig.refreshLiveStatus) {
        ensureNotCancelled();
        await persistResultSummary({ stage: "live_status" });
        const liveStatus = await refreshLiveStatusStep({
          shouldCancel: () => cancelRequestedAt !== null,
        });
        pipelineLogger.info("Live-status refresh finished", liveStatus);
      }

      ensureNotCancelled();
      await persistResultSummary({ stage: "selection" });
      const jobsToProcess = await selectJobsStep({
        scoredJobs,
        mergedConfig,
      });
      await persistResultSummary({
        stage: "selection",
        jobsScored: scoredJobs.length,
        jobsSelected: jobsToProcess.length,
      });

      pipelineLogger.info("Selected jobs for processing", {
        candidates: jobsToProcess.length,
      });

      let processedCount = 0;
      if (mergedConfig.enableAutoTailoring) {
        await persistResultSummary({
          stage: "processing",
          jobsScored: scoredJobs.length,
          jobsSelected: jobsToProcess.length,
        });
        ({ processedCount } = await processJobsStep({
          jobsToProcess,
          processJob,
          shouldCancel: () => cancelRequestedAt !== null,
        }));
      } else {
        pipelineLogger.info(
          "Auto-tailoring disabled; skipping processing step",
          { jobsSelected: jobsToProcess.length },
        );
      }
      jobsProcessed = processedCount;

      resultSummary = updatePipelineRunResultSummary(resultSummary, {
        stage: "completed",
        jobsScored: scoredJobs.length,
        jobsSelected: jobsToProcess.length,
      });
      await pipelineRepo.updatePipelineRun(pipelineRun.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        jobsProcessed: processedCount,
        resultSummary,
      });

      progressHelpers.complete(created, processedCount);
      pipelineLogger.info("Pipeline run completed", {
        jobsDiscovered: created,
        jobsProcessed: processedCount,
      });

      return {
        success: true,
        jobsDiscovered: created,
        jobsProcessed: processedCount,
      };
    } catch (error) {
      if (error instanceof PipelineCancelledError) {
        const message = "Cancelled by user request";
        await pipelineRepo.updatePipelineRun(pipelineRun.id, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
          jobsDiscovered,
          jobsProcessed,
          errorMessage: message,
          resultSummary,
        });
        progressHelpers.cancelled(message);
        pipelineLogger.info("Pipeline run cancelled", {
          jobsDiscovered,
          jobsProcessed,
        });
        return {
          success: false,
          jobsDiscovered,
          jobsProcessed,
          error: message,
        };
      }

      const message = error instanceof Error ? error.message : "Unknown error";

      await pipelineRepo.updatePipelineRun(pipelineRun.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: message,
        resultSummary,
      });

      progressHelpers.failed(message);
      pipelineLogger.error("Pipeline run failed", error);

      return {
        success: false,
        jobsDiscovered,
        jobsProcessed,
        error: message,
      };
    } finally {
      isPipelineRunning = false;
      activePipelineRunId = null;
      cancelRequestedAt = null;
    }
  });
}

export type ProcessJobOptions = {
  force?: boolean;
  requestOrigin?: string | null;
};

/**
 * Step 1: Pin the active CV to this job, then run cv-adjust to populate
 * `tailoredFields` and the ATS sidecar columns. The override map and the
 * matched/skipped lists are stored in place; `generateFinalPdf` then renders
 * the CV with those overrides applied.
 */
export async function summarizeJob(
  jobId: string,
  _options?: ProcessJobOptions,
): Promise<{
  success: boolean;
  error?: string;
}> {
  return runWithRequestContext({ jobId }, async () => {
    const jobLogger = logger.child({ jobId });
    jobLogger.info("Pinning job to active CV");
    try {
      const job = await jobsRepo.getJobById(jobId);
      if (!job) return { success: false, error: "Job not found" };

      const cv = await getActiveCvDocument();
      if (!cv) {
        return {
          success: false,
          error: "No CV uploaded yet. Upload a LaTeX CV before tailoring.",
        };
      }

      const lockedFieldIds = job.cvFieldLocks ?? [];
      const previousOverrides = job.tailoredFields ?? {};
      const adjust = await llmAdjustContent({
        personalBrief: cv.personalBrief,
        jobDescription: job.jobDescription ?? "",
        currentFields: cv.fields,
        currentOverrides: previousOverrides,
        lockedFieldIds,
        jobId: job.id,
        jobTitle: job.title,
        jobEmployer: job.employer,
      });

      if (!adjust.success) {
        // Hard-fail. The previous "pin with no overrides" fallback shipped
        // a baseline-identical PDF as if it were tailored.
        jobLogger.error(
          "Tailoring failed; refusing to ship a baseline-identical PDF",
          { error: adjust.error },
        );
        return {
          success: false,
          error: `Tailoring failed: ${adjust.error}`,
        };
      }

      const fieldIds = new Set(cv.fields.map((field) => field.id));
      const lockedSet = new Set(lockedFieldIds);
      const overrides: Record<string, string> = {};
      // Preserve any prior overrides on locked fields — re-tailoring must
      // not erase a user's protected edits even though the LLM was told
      // not to touch them.
      for (const [fid, val] of Object.entries(previousOverrides)) {
        if (lockedSet.has(fid) && fieldIds.has(fid)) overrides[fid] = val;
      }
      for (const patch of adjust.patches) {
        if (fieldIds.has(patch.fieldId)) {
          overrides[patch.fieldId] = patch.newValue;
        }
      }

      if (Object.keys(overrides).length === 0) {
        jobLogger.error(
          "Tailoring returned changes but none matched the active CV's fields",
          {
            proposedCount: adjust.patches.length,
            cvFieldCount: cv.fields.length,
            proposedFieldIds: adjust.patches.slice(0, 10).map((p) => p.fieldId),
            knownCvFieldIds: cv.fields.slice(0, 5).map((f) => f.id),
          },
        );
        return {
          success: false,
          error:
            "Tailoring produced no usable changes — every proposed change targeted a CV field that doesn't exist in the active CV.",
        };
      }

      jobLogger.info("Tailoring applied", {
        cvDocumentId: cv.id,
        proposedCount: adjust.patches.length,
        overrideCount: Object.keys(overrides).length,
        cvFieldCount: cv.fields.length,
        matched: adjust.matched.length,
        skipped: adjust.skipped.length,
      });

      await jobsRepo.updateJob(job.id, {
        cvDocumentId: cv.id,
        tailoredFields: overrides,
        tailoringMatched: adjust.matched,
        tailoringSkipped: adjust.skipped,
        tailoringFailureReason: null,
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      jobLogger.error("Pinning failed", error);
      return { success: false, error: message };
    }
  });
}

/**
 * Step 2: Render the pinned CV through the verbatim overrides + Tectonic
 * pass to a PDF. Reads the job again so cv-adjust's tailoredFields are
 * picked up.
 */
export async function generateFinalPdf(
  jobId: string,
  _options?: ProcessJobOptions,
): Promise<{
  success: boolean;
  error?: string;
}> {
  return runWithRequestContext({ jobId }, async () => {
    const jobLogger = logger.child({ jobId });
    jobLogger.info("Generating final PDF");
    try {
      const job = await jobsRepo.getJobById(jobId);
      if (!job) return { success: false, error: "Job not found" };

      const cvDocumentId = job.cvDocumentId;
      if (!cvDocumentId) {
        return {
          success: false,
          error: "Job is not pinned to a CV document. Run summarizeJob first.",
        };
      }

      // Status mutation only applies to the initial tailoring funnel
      // (discovered / selected → processing → ready). Re-tailoring a job
      // that's already past tailoring (ready / applied / in_progress /
      // closed / backlog / skipped) must preserve status: the user is
      // refreshing the PDF, not re-promoting the job. The previous
      // unconditional flip-to-processing → revert-to-discovered path
      // silently moved closed jobs into the Inbox tab, making them appear
      // to vanish.
      const originalStatus = job.status;
      // The initial tailoring funnel. The pipeline/auto path enters as
      // `discovered` and flips itself to `processing` here; the manual Tailor
      // button pre-sets `processing` at the route before calling in, so that
      // counts as in-funnel too. `selected` is retained for any legacy rows.
      const isInitialTailoringFunnel =
        originalStatus === "discovered" ||
        originalStatus === "selected" ||
        originalStatus === "processing";
      if (isInitialTailoringFunnel && originalStatus !== "processing") {
        await jobsRepo.updateJob(job.id, { status: "processing" });
      }

      const pdfResult = await generatePdf({
        jobId: job.id,
        cvDocumentId,
        overrides: job.tailoredFields,
      });

      if (!pdfResult.success) {
        // Keep the row in Tailoring (`processing`) on failure — processJob's
        // safety net records the reason, and the Tailoring tab renders a
        // reason-carrying `processing` row as a retryable failure instead of
        // bouncing it back to the Inbox.
        return { success: false, error: pdfResult.error };
      }

      if (isInitialTailoringFunnel) {
        await jobsRepo.updateJob(job.id, {
          status: "ready",
          pdfPath: pdfResult.pdfPath,
        });
      } else {
        await jobsRepo.updateJob(job.id, { pdfPath: pdfResult.pdfPath });
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      jobLogger.error("PDF generation failed", error);
      return { success: false, error: message };
    }
  });
}

/**
 * Process a single job (runs both steps in sequence).
 */
export async function processJob(
  jobId: string,
  options?: ProcessJobOptions,
): Promise<{
  success: boolean;
  error?: string;
}> {
  const result = await runProcessJob(jobId, options);
  if (!result.success) {
    try {
      // Record the failure reason and KEEP the row where it is. A failed tailor
      // in the funnel stays at `processing` so it can be retried in place — the
      // Tailoring tab renders a reason-carrying `processing` row as a retryable
      // failure rather than the non-interactive "Processing…" spinner. (This
      // replaced the old bounce-to-Inbox safety net.) Non-funnel re-tailors
      // (ready/applied/…) never sit at `processing`, so they keep their status.
      await jobsRepo.updateJob(jobId, {
        tailoringFailureReason: result.error ?? "Unknown error",
      });
    } catch (writeError) {
      logger.warn("Failed to persist tailoring failure reason", {
        jobId,
        error: writeError,
      });
    }
  }
  return result;
}

async function runProcessJob(
  jobId: string,
  options?: ProcessJobOptions,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Step 1: Summarize & Select Projects
    const sumResult = await summarizeJob(jobId, options);
    if (!sumResult.success) return sumResult;

    // Step 2: Generate PDF
    const pdfResult = await generateFinalPdf(jobId, options);
    return pdfResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { success: false, error: message };
  }
}

/**
 * Check if pipeline is currently running.
 *
 * A multi-profile sequence counts as running even in the gap between two
 * profiles, where `isPipelineRunning` is briefly false. Composed here rather
 * than at any one call site because this flag is a safety guard, not just
 * banner state: it gates the User Profile DB swap (which closes and replaces
 * the live SQLite file) and the claude-code CLI update. All consumers must
 * agree, or the next profile's run writes into a swapped database.
 */
export function getPipelineStatus(): {
  isRunning: boolean;
  /**
   * Which partition the run in flight belongs to, or null when nothing runs.
   *
   * `isRunning` deliberately stays unpartitioned — it guards the User-Profile
   * DB swap and the CLI updater, which care that ANY run is going. The trigger
   * is what lets a CLIENT say whose run it is: the 30s fallback poll feeds the
   * same state as the progress stream, and without this it cannot tell a
   * scheduled run from a manual one.
   */
  runningTrigger: RunTrigger | null;
} {
  const running = isPipelineRunning || isProfileSequenceActive();
  return {
    isRunning: running,
    runningTrigger: running ? activeRunTrigger() : null,
  };
}

export function requestPipelineCancel(): {
  accepted: boolean;
  pipelineRunId: string | null;
  alreadyRequested: boolean;
} {
  if (!isPipelineRunning) {
    return { accepted: false, pipelineRunId: null, alreadyRequested: false };
  }

  const pipelineRunId =
    activePipelineRunId && activePipelineRunId !== "pending"
      ? activePipelineRunId
      : null;

  if (cancelRequestedAt) {
    return {
      accepted: true,
      pipelineRunId,
      alreadyRequested: true,
    };
  }

  cancelRequestedAt = new Date().toISOString();
  return {
    accepted: true,
    pipelineRunId,
    alreadyRequested: false,
  };
}

export function isPipelineCancelRequested(): boolean {
  return cancelRequestedAt !== null;
}
