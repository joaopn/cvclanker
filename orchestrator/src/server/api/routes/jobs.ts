import {
  AppError,
  type AppErrorCode,
  badRequest,
  conflict,
  notFound,
  toAppError,
  unprocessableEntity,
} from "@infra/errors";
import { fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { setupSse, startSseHeartbeat, writeSseData } from "@infra/sse";
import {
  generateFinalPdf,
  processJob,
  summarizeJob,
} from "@server/pipeline/index";
import * as jobsRepo from "@server/repositories/jobs";
import * as settingsRepo from "@server/repositories/settings";
import { getActivePersonalBrief } from "@server/services/brief";
import { generateCoverLetter } from "@server/services/cover-letter/generate";
import { renderCoverLetterPdf } from "@server/services/cover-letter/render";
import { generateInterviewPrep } from "@server/services/interview-qa/generate";
import { resetRateLimitBudget } from "@server/services/llm/rate-limit-budget";
import {
  buildCvText,
  recomputeAtsCoverage,
} from "@server/services/cv/ats-coverage";
import { renderCvPdf } from "@server/services/cv/render-cv";
import { getActiveCvDocument } from "@server/services/cv-active";
import {
  cancelJobActionBatch,
  getJobActionBatches,
  hasRunningJobActionBatchWithAction,
  startJobActionBatch,
  subscribeToJobActionBatches,
} from "@server/services/job-actions/batch-store";
import { LLM_DRIVING_ACTIONS } from "@server/services/job-actions/llm-actions";
import { isUrlImportRunning } from "@server/services/url-import/batch-store";
import { isJobScoringEnabled } from "@server/services/job-scoring-settings";
import { fetchLinkedinLiveStatus } from "@server/services/live-status";
import { fetchJobDraft } from "@server/services/manualJob";
import {
  JobNotScoreableError,
  scoreJobSuitability,
} from "@server/services/scorer";
import { getEffectiveSettings } from "@server/services/settings";
import { extractExternalId } from "@shared/duplicate-identity";
import { settingsRegistry } from "@shared/settings-registry";
import {
  APPLICATION_OUTCOMES,
  SUITABILITY_CATEGORIES,
  type DuplicateJobGroupsResponse,
  type Job,
  type JobAction,
  type JobActionBatchStreamEvent,
  type JobActionResponse,
  type JobActionResult,
  type JobListItem,
  type JobOutcome,
  type JobStatus,
  type JobsListResponse,
  type JobsRevisionResponse,
  type ManualJobDraft,
  type UpdateJobInput,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const jobsRouter = Router();

const jobNoteSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(20000),
});

/**
 * PATCH /api/jobs/:id - Update a job
 */
const updateJobSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  employer: z.string().trim().min(1).max(500).optional(),
  jobUrl: z.string().trim().min(1).max(2000).url().optional(),
  applicationLink: z.string().trim().max(2000).url().nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  salary: z.string().trim().max(200).nullable().optional(),
  deadline: z.string().trim().max(100).nullable().optional(),
  status: z
    .enum([
      "discovered",
      "selected",
      "processing",
      "ready",
      "applied",
      "in_progress",
      "backlog",
      "stale",
      "skipped",
      "closed",
    ])
    .optional(),
  outcome: z.enum(APPLICATION_OUTCOMES).nullable().optional(),
  closedAt: z.number().int().nullable().optional(),
  // Server-managed everywhere except undo, which restores the pre-action value.
  appliedAt: z.string().trim().min(1).max(40).nullable().optional(),
  jobDescription: z.string().trim().nullable().optional(),
  suitabilityCategory: z.enum(SUITABILITY_CATEGORIES).nullable().optional(),
  suitabilityReason: z.string().optional(),
  coverLetterDraft: z.string().optional(),
  coverLetterDocumentId: z.string().min(1).nullable().optional(),
  coverLetterFieldOverrides: z.record(z.string(), z.string()).optional(),
  interviewPrep: z.string().max(20000).optional(),
  cvFieldLocks: z.array(z.string().min(1)).optional(),
  tailoredFields: z.record(z.string(), z.string()).optional(),
  tailoringFailureReason: z.string().nullable().optional(),
});

function isJobUrlConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /UNIQUE constraint failed: jobs\.job_url/i.test(error.message);
}

const updateOutcomeSchema = z.object({
  outcome: z.enum(APPLICATION_OUTCOMES).nullable(),
  closedAt: z.number().int().nullable().optional(),
});

const jobActionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("skip"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("rescore"),
    jobIds: z.array(z.string().min(1)).min(1),
    options: z
      .object({
        prefilter: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    action: z.literal("clear_score"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("rescrape"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("retailor"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("move_to_ready"),
    jobIds: z.array(z.string().min(1)).min(1),
    options: z
      .object({
        force: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    action: z.literal("move_to_backlog"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("move_to_stale"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("move_to_inbox"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("mark_closed"),
    jobIds: z.array(z.string().min(1)).min(1),
    options: z.object({
      outcome: z.enum(APPLICATION_OUTCOMES),
    }),
  }),
  z.object({
    action: z.literal("mark_duplicated"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("delete"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("reopen"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    action: z.literal("fetch_live_status"),
    jobIds: z.array(z.string().min(1)).min(1),
  }),
]);

const listJobsQuerySchema = z.object({
  status: z.string().optional(),
  view: z.enum(["full", "list"]).optional(),
  employer: z.string().min(1).optional(),
});

const jobsRevisionQuerySchema = z.object({
  status: z.string().optional(),
});

const SKIPPABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
  "discovered",
  "selected",
  "ready",
  "backlog",
  "stale",
]);

const MOVE_TO_READY_FROM_STATUSES: ReadonlySet<JobStatus> = new Set([
  "discovered",
  "backlog",
  "stale",
]);

const BACKLOG_FROM_STATUSES: ReadonlySet<JobStatus> = new Set([
  "discovered",
  "selected",
  "stale",
]);

const STALE_FROM_STATUSES: ReadonlySet<JobStatus> = new Set([
  "discovered",
  "selected",
  "backlog",
]);

const INBOX_FROM_STATUSES: ReadonlySet<JobStatus> = new Set(["stale"]);

const REOPENABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
  "skipped",
  "closed",
]);

const CLOSABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
  "applied",
  "in_progress",
]);
const DUPLICATE_FROM_STATUSES: ReadonlySet<JobStatus> = new Set([
  "discovered",
  "selected",
  "processing",
  "ready",
]);
const JOBS_BENCHMARK_ENABLED =
  process.env.BENCHMARK_JOBS_TIMING === "1" ||
  process.env.BENCHMARK_JOBS_TIMING === "true";

function parseStatusFilter(statusFilter?: string): JobStatus[] | undefined {
  const parsed = statusFilter?.split(",").filter(Boolean) as
    | JobStatus[]
    | undefined;
  return parsed && parsed.length > 0 ? parsed : undefined;
}

function resolveRequestOrigin(req: Request): string | null {
  const configuredBaseUrl = process.env.CVCLANKER_PUBLIC_BASE_URL?.trim();
  if (configuredBaseUrl) {
    try {
      const parsed = new URL(configuredBaseUrl);
      if (parsed.protocol && parsed.host) {
        return `${parsed.protocol}//${parsed.host}`;
      }
    } catch {
      // Ignore invalid env and fall back to request-derived origin.
    }
  }

  const trustProxy = Boolean(req.app?.get("trust proxy"));
  let protocol = (req.protocol || "").trim();
  let host = (req.header("host") || "").trim();

  if (trustProxy) {
    const forwardedProto =
      req.header("x-forwarded-proto")?.split(",")[0]?.trim() ?? "";
    const forwardedHost =
      req.header("x-forwarded-host")?.split(",")[0]?.trim() ?? "";
    if (forwardedProto) protocol = forwardedProto;
    if (forwardedHost) host = forwardedHost;
  }

  if (!host || !protocol) return null;
  return `${protocol}://${host}`;
}

function mapErrorForResult(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message || "Unknown error",
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Unknown error",
  };
}

type JobActionExecutionOptions = {
  getBriefForRescore?: () => Promise<string>;
  forceMoveToReady?: boolean;
  requestOrigin?: string | null;
  markClosedOutcome?: JobOutcome;
  rescrapeScoringEnabled?: boolean;
  /**
   * `rescore` only: run the cheap pre-filter before the scoring model. Off
   * unless the request asked for it by name — a manual rescore is the second
   * opinion on whatever the screen removed, so it must never screen by default.
   */
  rescorePrefilter?: boolean;
};

function createSharedRescoreBriefLoader(): () => Promise<string> {
  let briefPromise: Promise<string> | null = null;

  return async () => {
    if (!briefPromise) {
      briefPromise = getActivePersonalBrief();
    }
    return briefPromise;
  };
}

// Bounded FIFO runner for detached tailoring. A bulk "Tailor N" flips every
// row to `processing` and enqueues N background runs; without a cap that would
// spawn N concurrent LLM + tectonic jobs. The cap is the same
// `tailoringConcurrency` setting the pipeline's process step reads, so manual
// and automatic tailoring load the box the same way by construction.
let backgroundTailorActive = 0;
const backgroundTailorQueue: Array<() => void> = [];

function drainBackgroundTailorQueue(): void {
  if (backgroundTailorQueue.length === 0) return;
  void getEffectiveSettings()
    .then((settings) => settings.tailoringConcurrency.value)
    .catch((error) => {
      // A queued run must never strand: with zero active runs there is no
      // future completion to re-trigger the drain, so fall back to the
      // registry default instead of dropping the drain on the floor.
      logger.error("Background tailor drain fell back to default concurrency", {
        error: error instanceof Error ? error.message : String(error),
      });
      return settingsRegistry.tailoringConcurrency.default();
    })
    .then((limit) => {
      while (
        backgroundTailorActive < limit &&
        backgroundTailorQueue.length > 0
      ) {
        const next = backgroundTailorQueue.shift();
        if (next) next();
      }
    });
}

/**
 * Run a job's tailoring (LLM cv-adjust + PDF) detached from the request that
 * triggered it. The row has already been flipped to `processing`; processJob
 * resolves it to `ready` (success) or keeps it at `processing` with a persisted
 * `tailoringFailureReason` (failure) so it can be retried in place. Progress is
 * visible in the live LLM call queue. No request is awaiting this, so swallow +
 * log all rejections.
 */
function scheduleBackgroundTailor(
  jobId: string,
  options: { force?: boolean; requestOrigin?: string | null },
): void {
  const run = () => {
    backgroundTailorActive += 1;
    void processJob(jobId, options)
      .then((result) => {
        if (!result.success) {
          logger.warn("Background tailoring failed", {
            jobId,
            error: result.error,
          });
        }
      })
      .catch((error) => {
        logger.error("Background tailoring threw", error);
      })
      .finally(() => {
        backgroundTailorActive -= 1;
        drainBackgroundTailorQueue();
      });
  };

  backgroundTailorQueue.push(run);
  drainBackgroundTailorQueue();
}

// Trim-to-null normalization (reimplemented locally rather than reaching for
// manual-jobs.ts's module-private cleanOptional — a route module).
function trimToNull(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Only http(s) URLs can be re-fetched. Synthetic `manual://…` URLs (paste-JD
// jobs) and anything else are not rescrapable.
function isRescrapableUrl(url: string | null | undefined): boolean {
  return !!url && (url.startsWith("https://") || url.startsWith("http://"));
}

// Build the field patch for a rescrape. The description is overwritten
// unconditionally (trimmed) — it is the field partial-scrapes break, and its
// emptiness is guarded separately by the caller (→ 422). Every OTHER field is
// filled ONLY when the current stored value is missing (null/""/whitespace) and
// the fresh draft has a value — so a good existing title/salary is never
// clobbered by a weaker re-inference. `jobUrl` (identity key) and `status` are
// never touched.
function buildRescrapeUpdate(job: Job, draft: ManualJobDraft): UpdateJobInput {
  const update: UpdateJobInput = {
    jobDescription: trimToNull(draft.jobDescription),
  };

  // Returns the fresh value to write, or undefined to keep the existing one:
  // fill only when the current stored value is missing (null/""/whitespace) and
  // the draft carries a real value.
  const fillMissing = (
    current: string | null | undefined,
    fresh: string | undefined,
  ): string | undefined =>
    trimToNull(current) !== null ? undefined : (trimToNull(fresh) ?? undefined);

  const title = fillMissing(job.title, draft.title);
  if (title !== undefined) update.title = title;
  const employer = fillMissing(job.employer, draft.employer);
  if (employer !== undefined) update.employer = employer;
  const location = fillMissing(job.location, draft.location);
  if (location !== undefined) update.location = location;
  const salary = fillMissing(job.salary, draft.salary);
  if (salary !== undefined) update.salary = salary;
  const deadline = fillMissing(job.deadline, draft.deadline);
  if (deadline !== undefined) update.deadline = deadline;
  const applicationLink = fillMissing(job.applicationLink, draft.applicationLink);
  if (applicationLink !== undefined) update.applicationLink = applicationLink;

  return update;
}

async function executeJobActionForJob(
  action: JobAction,
  jobId: string,
  options?: JobActionExecutionOptions,
): Promise<JobActionResult> {
  try {
    const job = await jobsRepo.getJobById(jobId);
    if (!job) {
      throw new AppError({
        status: 404,
        code: "NOT_FOUND",
        message: "Job not found",
      });
    }

    if (action === "skip") {
      // A failed row parked at `processing` in Tailoring is skippable (give up
      // on it); a clean `processing` row is actively running and is not.
      const isFailedProcessing =
        job.status === "processing" && job.tailoringFailureReason != null;
      if (!SKIPPABLE_STATUSES.has(job.status) && !isFailedProcessing) {
        throw badRequest(`Job is not skippable from status "${job.status}"`, {
          jobId,
          status: job.status,
          allowedStatuses: Array.from(SKIPPABLE_STATUSES),
        });
      }

      const updated = await jobsRepo.updateJob(jobId, {
        status: "skipped",
        outcome: null,
        closedAt: null,
      });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "move_to_ready") {
      // A failed row sits at `processing` in the Tailoring tab; re-tailoring it
      // is a retry. A clean `processing` row (no failure reason) is actively
      // running and must not be re-triggered.
      const isRetry =
        job.status === "processing" && job.tailoringFailureReason != null;
      if (!MOVE_TO_READY_FROM_STATUSES.has(job.status) && !isRetry) {
        throw badRequest(
          `Job is not movable to Tailoring from status "${job.status}"`,
          {
            jobId,
            status: job.status,
            allowedStatuses: Array.from(MOVE_TO_READY_FROM_STATUSES),
          },
        );
      }

      // Flip to `processing` synchronously so the row jumps to the Tailoring
      // tab immediately, and clear any prior failure so a fresh attempt (or
      // retry) starts clean — reconcile keys off a null reason to tell an active
      // run from a failed one. The LLM tailoring + PDF runs detached; on failure
      // processJob keeps the row at `processing` with the reason set.
      const updated = await jobsRepo.updateJob(jobId, {
        status: "processing",
        tailoringFailureReason: null,
      });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      scheduleBackgroundTailor(jobId, {
        force: options?.forceMoveToReady ?? false,
        requestOrigin: options?.requestOrigin ?? null,
      });

      return { jobId, ok: true, job: updated };
    }

    if (action === "move_to_backlog") {
      if (!BACKLOG_FROM_STATUSES.has(job.status)) {
        throw badRequest(
          `Job is not movable to Backlog from status "${job.status}"`,
          {
            jobId,
            status: job.status,
            allowedStatuses: Array.from(BACKLOG_FROM_STATUSES),
          },
        );
      }

      const updated = await jobsRepo.updateJob(jobId, { status: "backlog" });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "move_to_stale") {
      if (!STALE_FROM_STATUSES.has(job.status)) {
        throw badRequest(
          `Job is not movable to Stale from status "${job.status}"`,
          {
            jobId,
            status: job.status,
            allowedStatuses: Array.from(STALE_FROM_STATUSES),
          },
        );
      }

      const updated = await jobsRepo.updateJob(jobId, { status: "stale" });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "move_to_inbox") {
      if (!INBOX_FROM_STATUSES.has(job.status)) {
        throw badRequest(
          `Job is not movable to Inbox from status "${job.status}"`,
          {
            jobId,
            status: job.status,
            allowedStatuses: Array.from(INBOX_FROM_STATUSES),
          },
        );
      }

      const updated = await jobsRepo.updateJob(jobId, { status: "discovered" });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "mark_closed") {
      if (!CLOSABLE_STATUSES.has(job.status)) {
        throw badRequest(`Job is not closable from status "${job.status}"`, {
          jobId,
          status: job.status,
          allowedStatuses: Array.from(CLOSABLE_STATUSES),
        });
      }
      if (!options?.markClosedOutcome) {
        throw badRequest("Mark closed requires an outcome", { jobId });
      }

      const updated = await jobsRepo.updateJob(jobId, {
        status: "closed",
        outcome: options.markClosedOutcome,
        closedAt: Math.floor(Date.now() / 1000),
      });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "delete") {
      // The one status that must not be deleted: a row actively being tailored
      // has a detached background run still holding it. A FAILED tailor also
      // sits at `processing` but carries a reason, and deleting one is exactly
      // what a user giving up on it would want — so the guard keys on the
      // reason, not on the status alone.
      if (job.status === "processing" && job.tailoringFailureReason == null) {
        throw badRequest(
          "Job is being tailored right now — wait for it to finish, or skip it first.",
          { jobId, status: job.status },
        );
      }

      const deleted = await jobsRepo.deleteJobById(jobId);
      if (!deleted) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      // The row it WAS. Every action result carries the job, and the client
      // only reads ids off this one — it has already been refetched away by the
      // time the list re-renders.
      return { jobId, ok: true, job };
    }

    if (action === "mark_duplicated") {
      if (!DUPLICATE_FROM_STATUSES.has(job.status)) {
        throw badRequest(
          `Job is not markable as duplicate from status "${job.status}"`,
          {
            jobId,
            status: job.status,
            allowedStatuses: Array.from(DUPLICATE_FROM_STATUSES),
          },
        );
      }

      const updated = await jobsRepo.updateJob(jobId, {
        status: "closed",
        outcome: "duplicated",
        closedAt: Math.floor(Date.now() / 1000),
      });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "reopen") {
      if (!REOPENABLE_STATUSES.has(job.status)) {
        throw badRequest(`Job is not reopenable from status "${job.status}"`, {
          jobId,
          status: job.status,
          allowedStatuses: Array.from(REOPENABLE_STATUSES),
        });
      }

      const updated = await jobsRepo.updateJob(jobId, {
        status: "discovered",
        outcome: null,
        closedAt: null,
      });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "rescrape") {
      if (job.status === "processing") {
        throw badRequest(
          `Job is not rescrapable from status "${job.status}"`,
          { jobId, status: job.status, disallowedStatus: "processing" },
        );
      }
      if (!isRescrapableUrl(job.jobUrl)) {
        throw badRequest("Job has no rescrapable URL", {
          jobId,
          jobUrl: job.jobUrl,
        });
      }

      // Re-fetch the source page and infer a fresh draft. Fetch/infer failures
      // throw AppError, caught below and mapped to the failure result.
      const { job: draft } = await fetchJobDraft(job.jobUrl); // usage/warning ignored
      const description = trimToNull(draft.jobDescription);
      if (!description) {
        throw unprocessableEntity(
          "Re-fetch returned no job description; the job was left unchanged.",
          { jobId },
        );
      }

      let updated = await jobsRepo.updateJob(
        jobId,
        buildRescrapeUpdate(job, draft),
      );
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      // The refreshed description changes fit — re-score inline so the streamed
      // row carries the new suitability. A scoring failure must NOT fail the
      // rescrape: the fields are already refreshed.
      if (options?.rescrapeScoringEnabled) {
        try {
          const brief = options.getBriefForRescore
            ? await options.getBriefForRescore()
            : await getActivePersonalBrief();
          const scored = await scoreJobSuitability(updated, brief);
          updated =
            (await jobsRepo.updateJob(jobId, {
              suitabilityCategory: scored.category,
              suitabilityReason: scored.reason,
              suitabilityModel: scored.model,
              suitabilityEffort: scored.effort,
            })) ?? updated;
        } catch (error) {
          if (!(error instanceof JobNotScoreableError)) {
            logger.warn("Rescrape rescore failed", { jobId, error });
          }
        }
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "clear_score") {
      // Drops the stored suitability so the job reads as Unscored and can be
      // scored afresh — the point being to re-run a batch against a new
      // personal brief without deleting and re-importing the jobs. Purely a
      // DB write: no LLM call, and the job keeps its status and its place.
      if (job.status === "processing") {
        throw badRequest(
          `Job's score is not clearable from status "${job.status}"`,
          { jobId, status: job.status, disallowedStatus: "processing" },
        );
      }

      const updated = await jobsRepo.updateJob(jobId, {
        suitabilityCategory: null,
        suitabilityReason: null,
        suitabilityModel: null,
        suitabilityEffort: null,
      });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "fetch_live_status") {
      // Live-status check: reads LinkedIn's public guest endpoint and writes
      // the three live_* columns; touches no status/score/tailoring field, so
      // no status guard — safe from any status, `processing` included. The id
      // guard runs BEFORE any fetch (keeps the hermetic route tests network-
      // free, and a non-LinkedIn row in a mixed selection fails fast).
      if (
        !extractExternalId({
          jobUrl: job.jobUrl,
          sourceJobId: job.sourceJobId,
        })
      ) {
        throw badRequest("Job has no LinkedIn posting id to check", {
          jobId,
          jobUrl: job.jobUrl,
        });
      }

      const status = await fetchLinkedinLiveStatus(job.jobUrl, job.sourceJobId);
      const updated = await jobsRepo.updateJob(jobId, {
        liveClosed: status.closed,
        liveApplicants: status.applicants,
        liveStatusCheckedAt: new Date().toISOString(),
      });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      return { jobId, ok: true, job: updated };
    }

    if (action === "retailor") {
      // Everything the Tailoring tab holds EXCEPT a live run: a tailored
      // (`ready`) row is re-tailored, a failed one (`processing` WITH a reason)
      // is retried in the same press.
      //
      // Rejecting a LIVE `processing` row (no reason) is the load-bearing half:
      // a detached tailor is queued or mid-write on it, and re-entering would
      // run two tailors against one row. It is also what keeps a second press of
      // Generate a no-op FOR EVERY ROW STILL RUNNING — the first press clears
      // every reason, so the rows it is still working on look exactly like
      // this. A row that has already FAILED is eligible again the moment its
      // reason lands, which is the retry this action exists to offer.
      // (Property of this action, not of the codebase: `POST /:id/re-tailor`
      // has no status guard at all and bypasses the FIFO — see B46.)
      //
      // Still not `applied`/`in_progress`/`closed`: the PDF there is the record
      // of what was actually sent, and flipping one to `processing` would move
      // the row out of its own tab (the bug `generateFinalPdf`'s comment
      // records). Nor the untailored shelves — `move_to_ready` owns those, and
      // they cannot be selected on this tab anyway.
      const isRetryableFailure =
        job.status === "processing" && job.tailoringFailureReason != null;
      if (job.status !== "ready" && !isRetryableFailure) {
        throw badRequest(
          job.status === "processing"
            ? "Job is already being tailored"
            : `Job is not re-tailorable from status "${job.status}"`,
          {
            jobId,
            status: job.status,
            // Real JobStatus values only, like every other arm (`skip` and
            // `move_to_ready` likewise omit their own failed-`processing`
            // allowance here). A "(failed)" pseudo-status would be prose in a
            // list a future consumer would try to map, and a boolean beside
            // `jobId`/`status` would read as a fact about THIS job — which it
            // never is, since the throw only fires on a live or off-tab row.
            allowedStatuses: ["ready"],
          },
        );
      }

      // Same move-then-tailor shape as `move_to_ready`: flip synchronously so
      // the row shows as in-flight, then tailor detached. The round trip needs
      // no engine change — pre-setting `processing` puts the job in
      // `generateFinalPdf`'s initial-tailoring funnel, whose success path
      // writes `ready` back. A failure leaves it at `processing` with a reason,
      // which the Tailoring tab renders as retryable in place.
      const updated = await jobsRepo.updateJob(jobId, {
        status: "processing",
        tailoringFailureReason: null,
      });
      if (!updated) {
        throw new AppError({
          status: 404,
          code: "NOT_FOUND",
          message: "Job not found",
        });
      }

      // `requestOrigin` is threaded for parity with `move_to_ready` and with
      // the single-job `/:id/re-tailor` — both reach the same `processJob`,
      // though only `move_to_ready` goes through this FIFO; `/:id/re-tailor`
      // calls it directly and unguarded (B46).
      // Both ProcessJobOptions fields are unread today (summarizeJob and
      // generateFinalPdf take them as `_options`); requestOrigin is a vestige
      // of the stripped tracer-link and analytics stack, which did build
      // absolute URLs from it. Keeping the tailoring entrances identical costs
      // nothing and means none of them silently lacks it if it is ever wired up
      // again. `force` is left off because nothing has ever read it and no
      // in-repo caller sets it.
      scheduleBackgroundTailor(jobId, {
        requestOrigin: options?.requestOrigin ?? null,
      });

      return { jobId, ok: true, job: updated };
    }

    // NOTE: everything past this point is the `rescore` arm — it is a bare
    // fallthrough, not an `action === "rescore"` guard, so a new action arm
    // MUST be inserted above or it silently rescores.
    if (job.status === "processing") {
      throw badRequest(`Job is not rescorable from status "${job.status}"`, {
        jobId,
        status: job.status,
        disallowedStatus: "processing",
      });
    }

    const brief = options?.getBriefForRescore
      ? await options.getBriefForRescore()
      : await getActivePersonalBrief();

    // Screening is opt-in per request and the UI asks for it by its own button;
    // a plain rescore stays the second opinion on whatever the screen removed.
    // Neither arm auto-skips — that lives in the pipeline's scoring step only,
    // so a screened rescore can write `bad_fit` but never moves the job.
    const scored = await scoreJobSuitability(job, brief, {
      prefilter: options?.rescorePrefilter === true,
    });

    const updated = await jobsRepo.updateJob(job.id, {
      suitabilityCategory: scored.category,
      suitabilityReason: scored.reason,
      suitabilityModel: scored.model,
      suitabilityEffort: scored.effort,
    });
    if (!updated) {
      throw new AppError({
        status: 404,
        code: "NOT_FOUND",
        message: "Job not found",
      });
    }

    return { jobId, ok: true, job: updated };
  } catch (error) {
    const mapped = mapErrorForResult(error);
    return {
      jobId,
      ok: false,
      error: {
        code: mapped.code,
        message: mapped.message,
      },
    };
  }
}

function mapJobActionFailure(
  failure: Extract<JobActionResult, { ok: false }>,
): AppError {
  const statusByCode: Record<AppErrorCode, number> = {
    INVALID_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    REQUEST_TIMEOUT: 408,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    SERVICE_UNAVAILABLE: 503,
    UPSTREAM_ERROR: 502,
    INTERNAL_ERROR: 500,
  };
  const code = (
    failure.error.code in statusByCode ? failure.error.code : "INTERNAL_ERROR"
  ) as AppErrorCode;

  return new AppError({
    status: statusByCode[code],
    code,
    message: failure.error.message,
  });
}

/**
 * GET /api/jobs - List all jobs
 * Query params: status (comma-separated list of statuses to filter)
 */
jobsRouter.get("/", async (req: Request, res: Response) => {
  try {
    const benchmarkStart = performance.now();
    let queryParseMs = 0;
    let primaryQueryMs = 0;
    const duplicateCandidatesQueryMs = 0;
    const duplicateMatchCpuMs = 0;
    let statsAggregateMs = 0;
    let revisionAggregateMs = 0;

    const queryParseStart = performance.now();
    const parsedQuery = listJobsQuerySchema.safeParse(req.query);
    queryParseMs = performance.now() - queryParseStart;
    if (!parsedQuery.success) {
      return fail(
        res,
        badRequest(
          "Invalid jobs list query parameters",
          parsedQuery.error.flatten(),
        ),
      );
    }

    const statusFilter = parsedQuery.data.status;
    const statuses = parseStatusFilter(statusFilter);
    const view = parsedQuery.data.view ?? "list";
    const employer = parsedQuery.data.employer;

    const primaryQueryStart = performance.now();
    const jobs: Array<Job | JobListItem> =
      view === "list"
        ? await jobsRepo.getJobListItems(statuses, employer)
        : await jobsRepo.getAllJobs(statuses);
    primaryQueryMs = performance.now() - primaryQueryStart;
    const candidateCount = 0;
    const duplicateMatchingEnabled = false;
    const statsAggregateStart = performance.now();
    const stats = await jobsRepo.getJobStats();
    statsAggregateMs = performance.now() - statsAggregateStart;
    const revisionAggregateStart = performance.now();
    const revision = await jobsRepo.getJobsRevision(statuses);
    revisionAggregateMs = performance.now() - revisionAggregateStart;

    const response: JobsListResponse<Job | JobListItem> = {
      jobs,
      total: jobs.length,
      byStatus: stats,
      revision: revision.revision,
    };
    const internalRouteMs =
      queryParseMs +
      primaryQueryMs +
      duplicateCandidatesQueryMs +
      duplicateMatchCpuMs +
      statsAggregateMs +
      revisionAggregateMs;
    const totalMs = performance.now() - benchmarkStart;

    if (JOBS_BENCHMARK_ENABLED) {
      logger.info("Jobs list benchmark", {
        route: "GET /api/jobs",
        view,
        statusFilter: statusFilter ?? null,
        returnedCount: jobs.length,
        duplicateMatchingEnabled,
        candidateCount,
        totalMs,
        queryParseMs,
        primaryQueryMs,
        duplicateCandidatesQueryMs,
        duplicateMatchCpuMs,
        statsAggregateMs,
        revisionAggregateMs,
        internalRouteMs,
      });
    }

    logger.info("Jobs list fetched", {
      route: "GET /api/jobs",
      view,
      statusFilter: statusFilter ?? null,
      revision: revision.revision,
      returnedCount: jobs.length,
    });

    ok(res, response);
  } catch (error) {
    const err =
      error instanceof AppError
        ? error
        : new AppError({
            status: 500,
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
          });
    fail(res, err);
  }
});

/**
 * GET /api/jobs/revision - Get jobs list revision for lightweight change detection
 * Query params: status (comma-separated list of statuses to filter)
 */
jobsRouter.get("/revision", async (req: Request, res: Response) => {
  try {
    const parsedQuery = jobsRevisionQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return fail(
        res,
        badRequest(
          "Invalid jobs revision query parameters",
          parsedQuery.error.flatten(),
        ),
      );
    }

    const statuses = parseStatusFilter(parsedQuery.data.status);
    const revision = await jobsRepo.getJobsRevision(statuses);

    const response: JobsRevisionResponse = {
      revision: revision.revision,
      latestUpdatedAt: revision.latestUpdatedAt,
      total: revision.total,
      statusFilter: revision.statusFilter,
    };

    logger.info("Jobs revision fetched", {
      route: "GET /api/jobs/revision",
      statusFilter: revision.statusFilter,
      revision: revision.revision,
      total: revision.total,
    });

    ok(res, response);
  } catch (error) {
    const err =
      error instanceof AppError
        ? error
        : new AppError({
            status: 500,
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
          });
    fail(res, err);
  }
});

/**
 * GET /api/jobs/duplicates - Active-triage jobs the board itself lists under
 * one posting id (groups of 2+). Rows with no parseable board id are not
 * proposed: missing evidence must never buy a match. On-demand cleanup surface.
 */
jobsRouter.get("/duplicates", async (_req: Request, res: Response) => {
  try {
    const groups = await jobsRepo.getDuplicateGroups();
    const response: DuplicateJobGroupsResponse = { groups };

    logger.info("Job duplicate groups fetched", {
      route: "GET /api/jobs/duplicates",
      groupCount: groups.length,
    });

    ok(res, response);
  } catch (error) {
    const err =
      error instanceof AppError
        ? error
        : new AppError({
            status: 500,
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
          });
    fail(res, err);
  }
});

type JobActionRequestInput = z.infer<typeof jobActionRequestSchema>;

interface PreparedJobAction {
  jobIds: string[];
  concurrency: number;
  options: JobActionExecutionOptions;
}

/**
 * The rate-limit latch is account-wide, so a second action must not clear it
 * while an LLM batch is still running: detachment turns "fired a second action
 * mid-batch" from a two-tab accident into the designed workflow, and unlatching
 * there just sends the running batch back into the same wall.
 */
function hasRunningLlmDrivingBatch(): boolean {
  return (
    hasRunningJobActionBatchWithAction(LLM_DRIVING_ACTIONS) ||
    // A URL import infers each row through the LLM and scores what it creates, so
    // it hits the same account-wide limit a rescore would.
    isUrlImportRunning()
  );
}

/**
 * Everything a bulk action needs resolved BEFORE its batch record exists, so a
 * registered batch's only failure mode is the pool itself. Keeping both awaits
 * here is what leaves the `maxBulkActionJobs` cap a real synchronous 400 and
 * stops a settings read from stranding a record in a non-terminal state.
 */
async function prepareJobActionExecution(
  req: Request,
  parsed: JobActionRequestInput,
): Promise<PreparedJobAction> {
  const settings = await getEffectiveSettings();
  if (LLM_DRIVING_ACTIONS.has(parsed.action) && !hasRunningLlmDrivingBatch()) {
    resetRateLimitBudget(settings.llmRateLimitRetries.value);
  }
  const maxBulkActionJobs = settings.maxBulkActionJobs.value;
  if (parsed.jobIds.length > maxBulkActionJobs) {
    throw badRequest(
      `Too many jobs for one action (max ${maxBulkActionJobs}).`,
    );
  }
  const requestOrigin = resolveRequestOrigin(req);
  const rescrapeScoringEnabled =
    parsed.action === "rescrape" ? await isJobScoringEnabled() : false;
  const options: JobActionExecutionOptions = {
    ...(parsed.action === "rescore"
      ? {
          getBriefForRescore: createSharedRescoreBriefLoader(),
          rescorePrefilter: parsed.options?.prefilter === true,
        }
      : {}),
    ...(parsed.action === "rescrape"
      ? {
          getBriefForRescore: createSharedRescoreBriefLoader(),
          rescrapeScoringEnabled,
        }
      : {}),
    ...(parsed.action === "move_to_ready" && parsed.options?.force !== undefined
      ? { forceMoveToReady: parsed.options.force }
      : {}),
    ...(parsed.action === "move_to_ready" || parsed.action === "retailor"
      ? { requestOrigin }
      : {}),
    ...(parsed.action === "mark_closed"
      ? { markClosedOutcome: parsed.options.outcome }
      : {}),
  };
  return {
    jobIds: Array.from(new Set(parsed.jobIds)),
    concurrency: settings.bulkActionConcurrency.value,
    options,
  };
}

/**
 * POST /api/jobs/actions - Run a job action across selected jobs
 */
jobsRouter.post("/actions", async (req: Request, res: Response) => {
  try {
    const parsed = jobActionRequestSchema.parse(req.body);
    const prepared = await prepareJobActionExecution(req, parsed);
    const dedupedJobIds = prepared.jobIds;

    // Registered in the batch registry like every other sweep, even though this
    // route still waits for its own result: the DB-swap and CLI-update guards
    // read that registry, and a sweep invisible to them gets its database
    // closed mid-write.
    const { done } = startJobActionBatch({
      action: parsed.action,
      jobIds: dedupedJobIds,
      concurrency: prepared.concurrency,
      retainResults: true,
      // This route answers with the full result set, so an unrelated client
      // must not be able to truncate it through the cancel endpoint.
      cancellable: false,
      runJob: (jobId) =>
        executeJobActionForJob(parsed.action, jobId, prepared.options),
    });
    const outcome = await done;
    if (outcome.error) throw outcome.error;
    const results = outcome.results;

    const succeeded = results.filter((result) => result.ok).length;
    const failed = results.length - succeeded;
    const payload: JobActionResponse = {
      action: parsed.action,
      requested: dedupedJobIds.length,
      succeeded,
      failed,
      results,
    };

    logger.info("Job action completed", {
      route: "POST /api/jobs/actions",
      action: parsed.action,
      requested: dedupedJobIds.length,
      succeeded,
      failed,
      concurrency: prepared.concurrency,
    });

    ok(res, payload);
  } catch (error) {
    const err =
      error instanceof z.ZodError
        ? badRequest("Invalid job action request", error.flatten())
        : error instanceof AppError
          ? error
          : new AppError({
              status: 500,
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : "Unknown error",
            });

    logger.error("Job action failed", {
      route: "POST /api/jobs/actions",
      status: err.status,
      code: err.code,
      details: err.details,
    });

    fail(res, err);
  }
});

/**
 * POST /api/jobs/actions/batch - Start a bulk action DETACHED from this request.
 *
 * Answers with the batch id and nothing else; progress is watched over
 * `/actions/batches/stream` by any client, including one that never saw the
 * request that started it. Closing the browser cancels nothing.
 */
jobsRouter.post("/actions/batch", async (req: Request, res: Response) => {
  try {
    const parsed = jobActionRequestSchema.parse(req.body);
    const prepared = await prepareJobActionExecution(req, parsed);

    const { batchId, done } = startJobActionBatch({
      action: parsed.action,
      jobIds: prepared.jobIds,
      concurrency: prepared.concurrency,
      runJob: (jobId) =>
        executeJobActionForJob(parsed.action, jobId, prepared.options),
    });
    // `done` cannot reject by construction; the catch keeps a future edit to
    // the store's finish path from turning that into a process-killer.
    void done.catch(() => {});

    logger.info("Job action batch started", {
      route: "POST /api/jobs/actions/batch",
      action: parsed.action,
      requested: prepared.jobIds.length,
      concurrency: prepared.concurrency,
      batchId,
    });

    ok(res, { batchId });
  } catch (error) {
    const err =
      error instanceof z.ZodError
        ? badRequest("Invalid job action request", error.flatten())
        : error instanceof AppError
          ? error
          : new AppError({
              status: 500,
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : "Unknown error",
            });
    fail(res, err);
  }
});

/**
 * GET /api/jobs/actions/batches - Every retained batch, for mount-time discovery
 * without opening a stream.
 */
jobsRouter.get("/actions/batches", (_req: Request, res: Response) => {
  ok(res, { batches: getJobActionBatches() });
});

/**
 * GET /api/jobs/actions/batches/stream - One multiplexed viewer over every
 * batch. A snapshot on connect, then per-batch progress and terminal events.
 *
 * One stream rather than one per batch: the client's SSE helper reconnects
 * indefinitely on a closed body, so a per-batch route would turn every evicted
 * batch into an endless reconnect loop — and the app already holds several
 * streams against the browser's per-origin cap.
 */
jobsRouter.get("/actions/batches/stream", (req: Request, res: Response) => {
  const requestId = String(res.getHeader("x-request-id") || "unknown");

  setupSse(res, {
    cacheControl: "no-cache, no-transform",
    disableBuffering: true,
    flushHeaders: true,
  });
  const stopHeartbeat = startSseHeartbeat(res);

  let clientDisconnected = false;
  const isWritable = () =>
    !clientDisconnected && !res.writableEnded && !res.destroyed;

  const sendEvent = (event: JobActionBatchStreamEvent) => {
    if (!isWritable()) return;
    writeSseData(res, event);
  };

  sendEvent({
    type: "snapshot",
    batches: getJobActionBatches(),
    requestId,
  });

  const unsubscribe = subscribeToJobActionBatches((update) => {
    if (update.batch.status !== "running") {
      sendEvent({ type: "terminal", batch: update.batch, requestId });
      return;
    }
    if (update.lastResult) {
      sendEvent({
        type: "progress",
        batch: update.batch,
        lastResult: update.lastResult,
        requestId,
      });
    }
  });

  const cleanup = () => {
    clientDisconnected = true;
    stopHeartbeat();
    unsubscribe();
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  res.on("close", () => {
    logger.debug("Job action batch stream client disconnected", { requestId });
    cleanup();
  });
  req.on("close", cleanup);
});

/**
 * POST /api/jobs/actions/batches/:id/cancel - Stop dispatching a running batch.
 *
 * Tasks already awaiting a provider run to completion; only undispatched items
 * are dropped, so the batch settles at `completed < requested`.
 */
jobsRouter.post(
  "/actions/batches/:id/cancel",
  (req: Request, res: Response) => {
    // Refused for three distinct reasons — unknown id, already finished, or a
    // batch whose caller returns the full result set itself — so the message
    // covers all three rather than claiming the id does not exist.
    const cancelled = cancelJobActionBatch(req.params.id);
    if (!cancelled) {
      return fail(res, notFound("No cancellable batch running with that id"));
    }
    logger.info("Job action batch cancellation requested", {
      route: "POST /api/jobs/actions/batches/:id/cancel",
      batchId: req.params.id,
    });
    ok(res, { cancelled: true });
  },
);

const sweepStaleRequestSchema = z.object({
  thresholdDays: z.number().int().min(1).max(365),
  // `shelf` (default) sweeps Inbox/Selected/Backlog; `tailoring` sweeps the
  // Tailoring tab's finished Ready rows on explicit request.
  scope: z.enum(["shelf", "tailoring"]).optional(),
});

/**
 * POST /api/jobs/sweep-live-closed - Bulk-move shelf rows whose live
 * LinkedIn check found the posting closed ("No longer accepting
 * applications") into `stale`. Same shape as sweep-stale: single pass,
 * returns the count plus a per-source-status breakdown for the toast.
 */
jobsRouter.post("/sweep-live-closed", async (_req: Request, res: Response) => {
  try {
    const result = await jobsRepo.sweepLiveClosedJobs();

    logger.info("Live-closed sweep completed", {
      route: "POST /api/jobs/sweep-live-closed",
      moved: result.moved,
      breakdown: result.breakdown,
    });

    ok(res, result);
  } catch (error) {
    const err =
      error instanceof AppError
        ? error
        : new AppError({
            status: 500,
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
          });

    logger.error("Live-closed sweep failed", {
      route: "POST /api/jobs/sweep-live-closed",
      status: err.status,
      code: err.code,
      details: err.details,
    });

    fail(res, err);
  }
});

/**
 * POST /api/jobs/sweep-stale - Bulk-move aged rows into `stale`. The `scope`
 * bounds the source statuses: `shelf` (default) covers {discovered, selected,
 * backlog}; `tailoring` covers {ready}. Returns the row count plus a
 * per-source-status breakdown so the UI can render a meaningful toast.
 */
jobsRouter.post("/sweep-stale", async (req: Request, res: Response) => {
  try {
    const parsed = sweepStaleRequestSchema.parse(req.body);
    const result = await jobsRepo.sweepStaleJobs(
      parsed.thresholdDays,
      parsed.scope ?? "shelf",
    );

    logger.info("Stale sweep completed", {
      route: "POST /api/jobs/sweep-stale",
      thresholdDays: parsed.thresholdDays,
      scope: parsed.scope ?? "shelf",
      moved: result.moved,
      breakdown: result.breakdown,
    });

    ok(res, result);
  } catch (error) {
    const err =
      error instanceof z.ZodError
        ? badRequest("Invalid sweep-stale request", error.flatten())
        : error instanceof AppError
          ? error
          : new AppError({
              status: 500,
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : "Unknown error",
            });

    logger.error("Stale sweep failed", {
      route: "POST /api/jobs/sweep-stale",
      status: err.status,
      code: err.code,
      details: err.details,
    });

    fail(res, err);
  }
});

jobsRouter.post("/:id/process", async (req: Request, res: Response) => {
  const forceRaw = req.query.force as string | undefined;
  const force = forceRaw === "1" || forceRaw === "true";
  const result = await executeJobActionForJob("move_to_ready", req.params.id, {
    forceMoveToReady: force,
    requestOrigin: resolveRequestOrigin(req),
  });
  if (!result.ok) return fail(res, mapJobActionFailure(result));
  ok(res, result.job);
});

jobsRouter.post("/:id/skip", async (req: Request, res: Response) => {
  const result = await executeJobActionForJob("skip", req.params.id);
  if (!result.ok) return fail(res, mapJobActionFailure(result));
  ok(res, result.job);
});

jobsRouter.post("/:id/rescore", async (req: Request, res: Response) => {
  const result = await executeJobActionForJob("rescore", req.params.id, {
    getBriefForRescore: createSharedRescoreBriefLoader(),
  });
  if (!result.ok) return fail(res, mapJobActionFailure(result));
  ok(res, result.job);
});

// Recompute ATS keyword coverage against the CURRENT CV (per-job overrides
// else source defaults) without re-tailoring or regenerating the PDF. Pure
// string match over the job's existing keyword universe (matched ∪ skipped).
jobsRouter.post("/:id/refresh-ats", async (req: Request, res: Response) => {
  try {
    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) return fail(res, notFound("Job not found"));

    const keywords = [
      ...(job.tailoringMatched ?? []),
      ...(job.tailoringSkipped ?? []),
    ];
    if (keywords.length === 0) {
      return fail(
        res,
        badRequest(
          "No ATS keywords on this job yet — tailor it first to populate them.",
        ),
      );
    }

    const cv = await getActiveCvDocument();
    if (!cv) {
      return fail(
        res,
        conflict("No CV uploaded yet. Upload a LaTeX CV before tailoring."),
      );
    }

    const cvText = buildCvText(cv.fields, job.tailoredFields ?? {});
    const { matched, skipped } = recomputeAtsCoverage(cvText, keywords);

    const updated = await jobsRepo.updateJob(job.id, {
      tailoringMatched: matched,
      tailoringSkipped: skipped,
      tailoringFailureReason: null,
    });
    if (!updated) return fail(res, notFound("Job not found"));
    ok(res, updated);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * GET /api/jobs/:id - Get a single job
 */
jobsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) {
      return fail(res, notFound("Job not found"));
    }
    ok(res, job);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * GET /api/jobs/:id/notes - Get notes for a job
 */
jobsRouter.get("/:id/notes", async (req: Request, res: Response) => {
  const requestId = String(res.getHeader("x-request-id") || "unknown");

  try {
    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) {
      const err = notFound("Job not found");
      logger.warn("Job notes fetch failed", {
        route: "GET /api/jobs/:id/notes",
        jobId: req.params.id,
        requestId,
        status: err.status,
        code: err.code,
      });
      return fail(res, err);
    }

    const notes = await jobsRepo.listJobNotes(job.id);

    logger.info("Job notes fetched", {
      route: "GET /api/jobs/:id/notes",
      jobId: job.id,
      requestId,
      returnedCount: notes.length,
    });

    ok(res, notes);
  } catch (error) {
    const err = toAppError(error);
    logger.error("Job notes fetch failed", {
      route: "GET /api/jobs/:id/notes",
      jobId: req.params.id,
      requestId,
      status: err.status,
      code: err.code,
      details: err.details,
      errorMessage: error instanceof Error ? error.message : undefined,
    });
    fail(res, err);
  }
});

/**
 * POST /api/jobs/:id/notes - Create a note for a job
 */
jobsRouter.post("/:id/notes", async (req: Request, res: Response) => {
  const requestId = String(res.getHeader("x-request-id") || "unknown");

  try {
    const input = jobNoteSchema.safeParse(req.body);
    if (!input.success) {
      return fail(
        res,
        badRequest("Invalid job note request", input.error.flatten()),
      );
    }

    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) {
      const err = notFound("Job not found");
      logger.warn("Job note create failed", {
        route: "POST /api/jobs/:id/notes",
        jobId: req.params.id,
        requestId,
        status: err.status,
        code: err.code,
      });
      return fail(res, err);
    }

    const note = await jobsRepo.createJobNote({
      jobId: job.id,
      ...input.data,
    });

    logger.info("Job note created", {
      route: "POST /api/jobs/:id/notes",
      jobId: job.id,
      noteId: note.id,
      requestId,
    });

    ok(res, note, 201);
  } catch (error) {
    const err = toAppError(error);
    logger.error("Job note create failed", {
      route: "POST /api/jobs/:id/notes",
      jobId: req.params.id,
      requestId,
      status: err.status,
      code: err.code,
      details: err.details,
      errorMessage: error instanceof Error ? error.message : undefined,
    });
    fail(res, err);
  }
});

/**
 * PATCH /api/jobs/:id/notes/:noteId - Update a job note
 */
jobsRouter.patch("/:id/notes/:noteId", async (req: Request, res: Response) => {
  const requestId = String(res.getHeader("x-request-id") || "unknown");

  try {
    const input = jobNoteSchema.safeParse(req.body);
    if (!input.success) {
      return fail(
        res,
        badRequest("Invalid job note request", input.error.flatten()),
      );
    }

    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) {
      const err = notFound("Job not found");
      logger.warn("Job note update failed", {
        route: "PATCH /api/jobs/:id/notes/:noteId",
        jobId: req.params.id,
        noteId: req.params.noteId,
        requestId,
        status: err.status,
        code: err.code,
      });
      return fail(res, err);
    }

    const note = await jobsRepo.updateJobNote({
      jobId: job.id,
      noteId: req.params.noteId,
      ...input.data,
    });
    if (!note) {
      const err = notFound("Job note not found");
      logger.warn("Job note update failed", {
        route: "PATCH /api/jobs/:id/notes/:noteId",
        jobId: job.id,
        noteId: req.params.noteId,
        requestId,
        status: err.status,
        code: err.code,
      });
      return fail(res, err);
    }

    logger.info("Job note updated", {
      route: "PATCH /api/jobs/:id/notes/:noteId",
      jobId: job.id,
      noteId: note.id,
      requestId,
    });

    ok(res, note);
  } catch (error) {
    const err = toAppError(error);
    logger.error("Job note update failed", {
      route: "PATCH /api/jobs/:id/notes/:noteId",
      jobId: req.params.id,
      noteId: req.params.noteId,
      requestId,
      status: err.status,
      code: err.code,
      details: err.details,
      errorMessage: error instanceof Error ? error.message : undefined,
    });
    fail(res, err);
  }
});

/**
 * DELETE /api/jobs/:id/notes/:noteId - Delete a job note
 */
jobsRouter.delete("/:id/notes/:noteId", async (req: Request, res: Response) => {
  const requestId = String(res.getHeader("x-request-id") || "unknown");

  try {
    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) {
      const err = notFound("Job not found");
      logger.warn("Job note delete failed", {
        route: "DELETE /api/jobs/:id/notes/:noteId",
        jobId: req.params.id,
        noteId: req.params.noteId,
        requestId,
        status: err.status,
        code: err.code,
      });
      return fail(res, err);
    }

    const deletedCount = await jobsRepo.deleteJobNote({
      jobId: job.id,
      noteId: req.params.noteId,
    });
    if (deletedCount === 0) {
      const err = notFound("Job note not found");
      logger.warn("Job note delete failed", {
        route: "DELETE /api/jobs/:id/notes/:noteId",
        jobId: job.id,
        noteId: req.params.noteId,
        requestId,
        status: err.status,
        code: err.code,
      });
      return fail(res, err);
    }

    logger.info("Job note deleted", {
      route: "DELETE /api/jobs/:id/notes/:noteId",
      jobId: job.id,
      noteId: req.params.noteId,
      requestId,
    });

    ok(res, null);
  } catch (error) {
    const err = toAppError(error);
    logger.error("Job note delete failed", {
      route: "DELETE /api/jobs/:id/notes/:noteId",
      jobId: req.params.id,
      noteId: req.params.noteId,
      requestId,
      status: err.status,
      code: err.code,
      details: err.details,
      errorMessage: error instanceof Error ? error.message : undefined,
    });
    fail(res, err);
  }
});

/**
 * PATCH /api/jobs/:id/outcome - Close out application
 */
jobsRouter.patch("/:id/outcome", async (req: Request, res: Response) => {
  try {
    const input = updateOutcomeSchema.parse(req.body);
    const closedAt = input.outcome
      ? (input.closedAt ?? Math.floor(Date.now() / 1000))
      : null;
    const job = await jobsRepo.updateJob(req.params.id, {
      outcome: input.outcome,
      closedAt,
    });

    if (!job) {
      return fail(res, notFound("Job not found"));
    }

    ok(res, job);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});

jobsRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const input = updateJobSchema.parse(req.body);
    const settings = await getEffectiveSettings();

    if (typeof input.jobDescription === "string") {
      const max = settings.maxJobDescriptionChars.value;
      if (input.jobDescription.length > max) {
        return fail(
          res,
          unprocessableEntity(
            `jobDescription exceeds the configured limit (${input.jobDescription.length} > ${max} chars).`,
            {
              field: "jobDescription",
              observed: input.jobDescription.length,
              max,
            },
          ),
        );
      }
    }

    if (typeof input.coverLetterDraft === "string") {
      const max = settings.maxCoverLetterChars.value;
      if (input.coverLetterDraft.length > max) {
        return fail(
          res,
          unprocessableEntity(
            `coverLetterDraft exceeds the configured limit (${input.coverLetterDraft.length} > ${max} chars).`,
            {
              field: "coverLetterDraft",
              observed: input.coverLetterDraft.length,
              max,
            },
          ),
        );
      }
    }

    const currentJob = await jobsRepo.getJobById(req.params.id);

    if (!currentJob) {
      const err = new AppError({
        status: 404,
        code: "NOT_FOUND",
        message: "Job not found",
      });
      logger.warn("Job update failed", {
        route: "PATCH /api/jobs/:id",
        jobId: req.params.id,
        status: err.status,
        code: err.code,
      });
      fail(res, err);
      return;
    }

    const job = await jobsRepo.updateJob(req.params.id, input);

    if (!job) {
      const err = new AppError({
        status: 404,
        code: "NOT_FOUND",
        message: "Job not found",
      });
      logger.warn("Job update failed", {
        route: "PATCH /api/jobs/:id",
        jobId: req.params.id,
        status: err.status,
        code: err.code,
      });
      return fail(res, err);
    }

    logger.info("Job updated", {
      route: "PATCH /api/jobs/:id",
      jobId: req.params.id,
      updatedFields: Object.keys(input),
    });

    ok(res, job);
  } catch (error) {
    const err =
      error instanceof z.ZodError
        ? badRequest(
            error.issues[0]?.message ?? "Invalid job update request",
            error.flatten(),
          )
        : isJobUrlConflictError(error)
          ? conflict("Another job already uses that job URL")
          : error instanceof AppError
            ? error
            : new AppError({
                status: 500,
                code: "INTERNAL_ERROR",
                message:
                  error instanceof Error ? error.message : "Unknown error",
              });

    logger.error("Job update failed", {
      route: "PATCH /api/jobs/:id",
      jobId: req.params.id,
      status: err.status,
      code: err.code,
      details: err.details,
    });

    fail(res, err);
  }
});

/**
 * POST /api/jobs/:id/summarize - Generate AI summary and suggest projects
 */
jobsRouter.post("/:id/summarize", async (req: Request, res: Response) => {
  try {
    const forceRaw = req.query.force as string | undefined;
    const force = forceRaw === "1" || forceRaw === "true";

    const result = await summarizeJob(req.params.id, { force });

    if (!result.success) {
      return fail(
        res,
        badRequest(result.error ?? "Failed to summarize the job"),
      );
    }

    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) {
      return fail(res, notFound("Job not found"));
    }
    ok(res, job);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/jobs/:id/generate-pdf - Generate PDF using current manual overrides
 */
jobsRouter.post("/:id/generate-pdf", async (req: Request, res: Response) => {
  try {
    const result = await generateFinalPdf(req.params.id, {
      requestOrigin: resolveRequestOrigin(req),
    });

    if (!result.success) {
      return fail(
        res,
        badRequest(result.error ?? "Failed to generate a resume PDF"),
      );
    }

    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) {
      return fail(res, notFound("Job not found"));
    }
    ok(res, job);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/jobs/:id/re-tailor - Re-run cv-adjust against the current
 * personal_brief + JD + active CV fields, re-render the PDF, and update
 * tailoredFields + tailoringMatched/Skipped + pdfPath in place.
 */
jobsRouter.post("/:id/re-tailor", async (req: Request, res: Response) => {
  try {
    const result = await processJob(req.params.id, {
      requestOrigin: resolveRequestOrigin(req),
    });

    if (!result.success) {
      return fail(res, badRequest(result.error ?? "Re-tailor failed"));
    }

    const job = await jobsRepo.getJobById(req.params.id);
    if (!job) {
      return fail(res, notFound("Job not found"));
    }
    ok(res, job);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/jobs/:id/generate-cover-letter - Run cover-letter Generate
 * for this job. Strict-JSON LLM call against the active cover-letter
 * document's body field; merges the returned override into
 * `coverLetterFieldOverrides`. Returns the updated job.
 */
jobsRouter.post(
  "/:id/generate-cover-letter",
  async (req: Request, res: Response) => {
    try {
      const result = await generateCoverLetter({ jobId: req.params.id });
      if (!result.success) {
        return fail(
          res,
          badRequest(result.error ?? "Cover-letter generation failed"),
        );
      }
      ok(res, result.job);
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

/**
 * POST /api/jobs/:id/generate-interview-prep - Run Interview QA for this
 * job. The LLM produces a freeform interview strategy (markdown) from the
 * JD + personal brief + tailored CV fields; the optional `steer` body
 * field carries free-text steering from the tab. Persisted to
 * `jobs.interviewPrep`. Returns the updated job. Manual-only.
 */
const generateInterviewPrepSchema = z.object({
  steer: z.string().max(2000).optional(),
});

jobsRouter.post(
  "/:id/generate-interview-prep",
  async (req: Request, res: Response) => {
    const parsed = generateInterviewPrepSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return fail(res, badRequest("Invalid interview-prep request."));
    }
    try {
      const result = await generateInterviewPrep({
        jobId: req.params.id,
        steer: parsed.data.steer,
      });
      if (!result.success) {
        return fail(
          res,
          badRequest(result.error ?? "Interview QA generation failed"),
        );
      }
      ok(res, result.job);
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

/**
 * POST /api/jobs/:id/render-cover-letter - Render the cover-letter PDF
 * for this job by substituting `coverLetterFieldOverrides` (textarea
 * state) into the active cover-letter doc's templated tex. No LLM call.
 */
jobsRouter.post(
  "/:id/render-cover-letter",
  async (req: Request, res: Response) => {
    try {
      const result = await renderCoverLetterPdf({ jobId: req.params.id });
      if (!result.success) {
        return fail(
          res,
          badRequest(result.error ?? "Cover-letter render failed"),
        );
      }
      ok(res, result.job);
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

/**
 * POST /api/jobs/:id/render-cv - Render the CV PDF for this job by
 * substituting `tailoredFields` (per-field override map) into the
 * pinned CV doc's templated tex. No LLM call — just template + tectonic.
 */
jobsRouter.post(
  "/:id/render-cv",
  async (req: Request, res: Response) => {
    try {
      const result = await renderCvPdf({ jobId: req.params.id });
      if (!result.success) {
        return fail(res, badRequest(result.error ?? "CV render failed"));
      }
      ok(res, result.job);
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

/**
 * POST /api/jobs/:id/apply - Mark a job as applied
 */
jobsRouter.post("/:id/apply", async (req: Request, res: Response) => {
  try {
    const job = await jobsRepo.getJobById(req.params.id);

    if (!job) {
      return fail(res, notFound("Job not found"));
    }

    // No explicit `appliedAt`: an explicit value takes `updateJob`'s
    // pass-through branch and OVERWRITES, while the bare status change takes
    // the `coalesce(applied_at, now)` arm that stamps once and keeps the first
    // apply date for ever. This route is every "Mark applied" surface (the
    // Ready panel, the detail panel, the `a` shortcut), so sending a fresh
    // timestamp here re-dated any job applied, moved back to Tailoring by the
    // stage switcher, and applied again — silently shifting it under the
    // Applied date filter too.
    const updatedJob = await jobsRepo.updateJob(job.id, {
      status: "applied",
    });

    if (!updatedJob) {
      return fail(res, notFound("Job not found"));
    }

    ok(res, updatedJob);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * DELETE /api/jobs/status/:status - Clear jobs with a specific status
 */
jobsRouter.delete("/status/:status", async (req: Request, res: Response) => {
  try {
    const status = req.params.status as JobStatus;
    const count = await jobsRepo.deleteJobsByStatus(status);

    ok(res, {
      message: `Cleared ${count} ${status} jobs`,
      count,
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * DELETE /api/jobs/category/:category - Clear jobs whose suitability_category
 * is at-or-below the supplied category (excluding post-apply statuses).
 */
jobsRouter.delete(
  "/category/:category",
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.category;
      if (!(SUITABILITY_CATEGORIES as readonly string[]).includes(raw)) {
        return fail(
          res,
          badRequest(
            `Category must be one of: ${SUITABILITY_CATEGORIES.join(", ")}`,
          ),
        );
      }
      const category = raw as (typeof SUITABILITY_CATEGORIES)[number];
      const targetRank = SUITABILITY_CATEGORIES.indexOf(category);
      const categoriesToDelete = SUITABILITY_CATEGORIES.filter(
        (_value, idx) => idx >= targetRank,
      );
      const count = await jobsRepo.deleteJobsByCategory(categoriesToDelete);

      ok(res, {
        message: `Cleared ${count} jobs at or below "${category}"`,
        count,
        category,
      });
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);
