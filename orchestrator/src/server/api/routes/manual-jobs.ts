import { randomUUID } from "node:crypto";
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  toAppError,
} from "@infra/errors";
import { fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { setupSse, startSseHeartbeat, writeSseData } from "@infra/sse";
import { processJob } from "@server/pipeline/index";
import * as jobsRepo from "@server/repositories/jobs";
import { getActivePersonalBrief } from "@server/services/brief";
import { isJobScoringEnabled } from "@server/services/job-scoring-settings";
import {
  fetchAndExtractJobContent,
  fetchJobDraft,
  inferManualJobDetails,
} from "@server/services/manualJob";
import {
  JobNotScoreableError,
  scoreJobSuitability,
} from "@server/services/scorer";
import { getEffectiveSettings } from "@server/services/settings";
import {
  cancelUrlImportBatch,
  getUrlImportBatch,
  getUrlImportDraft,
  resolveUrlImportItem,
  startUrlImportBatch,
  subscribeToUrlImportBatch,
  type UrlImportOutcome,
} from "@server/services/url-import/batch-store";
import { canonicalizeJobUrl } from "@shared/job-url";
import { tailoringFailureSummary } from "@shared/tailoring-failure";
import {
  BATCH_URL_IMPORT_MAX_URLS,
  type BatchUrlImportItemResult,
  type BatchUrlImportTokenUsage,
  type ManualJobDraft,
  type UrlImportBatchStreamEvent,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const manualJobsRouter = Router();

const manualJobFetchSchema = z.object({
  url: z.string().trim().url().max(2000),
});

const manualJobInferenceSchema = z.object({
  jobDescription: z.string().trim().min(1).max(60000),
});

const manualJobImportSchema = z.object({
  job: z.object({
    title: z.string().trim().min(1).max(500),
    employer: z.string().trim().min(1).max(500),
    jobUrl: z.string().trim().url().max(2000).optional(),
    applicationLink: z.string().trim().url().max(2000).optional(),
    location: z.string().trim().max(200).optional(),
    salary: z.string().trim().max(200).optional(),
    deadline: z.string().trim().max(100).optional(),
    jobDescription: z.string().trim().min(1).max(40000),
    jobType: z.string().trim().max(200).optional(),
    jobLevel: z.string().trim().max(200).optional(),
    jobFunction: z.string().trim().max(200).optional(),
    disciplines: z.string().trim().max(200).optional(),
    degreeRequired: z.string().trim().max(200).optional(),
    starting: z.string().trim().max(200).optional(),
  }),
});

const cleanOptional = (value?: string | null) => {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * POST /api/manual-jobs/fetch - Fetch and extract job content from a URL
 */
manualJobsRouter.post("/fetch", async (req: Request, res: Response) => {
  try {
    const input = manualJobFetchSchema.parse(req.body ?? {});
    const result = await fetchAndExtractJobContent(input.url);
    ok(res, result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/manual-jobs/infer - Infer job details from a pasted description
 */
manualJobsRouter.post("/infer", async (req: Request, res: Response) => {
  try {
    const input = manualJobInferenceSchema.parse(req.body ?? {});
    const result = await inferManualJobDetails(input.jobDescription);

    ok(res, {
      job: result.job,
      warning: result.warning ?? null,
      usage: result.usage ?? null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/manual-jobs/import - Import a manually curated job into the DB
 */
manualJobsRouter.post("/import", async (req: Request, res: Response) => {
  try {
    const input = manualJobImportSchema.parse(req.body ?? {});
    const job = input.job;

    const jobUrl =
      cleanOptional(job.jobUrl) ||
      cleanOptional(job.applicationLink) ||
      `manual://${randomUUID()}`;

    const createdJob = await jobsRepo.createJob({
      source: "manual",
      title: job.title.trim(),
      employer: job.employer.trim(),
      jobUrl,
      applicationLink: cleanOptional(job.applicationLink) ?? undefined,
      location: cleanOptional(job.location) ?? undefined,
      salary: cleanOptional(job.salary) ?? undefined,
      deadline: cleanOptional(job.deadline) ?? undefined,
      jobDescription: job.jobDescription.trim(),
      jobType: cleanOptional(job.jobType) ?? undefined,
      jobLevel: cleanOptional(job.jobLevel) ?? undefined,
      jobFunction: cleanOptional(job.jobFunction) ?? undefined,
      disciplines: cleanOptional(job.disciplines) ?? undefined,
      degreeRequired: cleanOptional(job.degreeRequired) ?? undefined,
      starting: cleanOptional(job.starting) ?? undefined,
    });

    const processResult = await processJob(createdJob.id);
    if (!processResult.success) {
      logger.warn("Manual job auto-processing failed", {
        jobId: createdJob.id,
        error: processResult.error ?? "Unknown error",
      });
      return fail(
        res,
        new AppError({
          status: 502,
          code: "UPSTREAM_ERROR",
          // Summary only: this is a toast. `processJob` has already stored
          // the full reason on the job, where the failure box reveals it.
          message:
            tailoringFailureSummary(processResult.error) ||
            "Imported job but failed to move it to ready automatically",
          details: { jobId: createdJob.id },
        }),
      );
    }

    const processedJob = await jobsRepo.getJobById(createdJob.id);
    if (!processedJob) {
      return fail(res, notFound("Job not found"));
    }

    // Score asynchronously so the import returns immediately.
    (async () => {
      try {
        const brief = await getActivePersonalBrief();
        const scored = await scoreJobSuitability(processedJob, brief);
        await jobsRepo.updateJob(processedJob.id, {
          suitabilityCategory: scored.category,
          suitabilityReason: scored.reason,
          suitabilityModel: scored.model,
          suitabilityEffort: scored.effort,
        });
      } catch (error) {
        if (error instanceof JobNotScoreableError) {
          logger.info("Skipping unscoreable manual job", {
            jobId: processedJob.id,
          });
          return;
        }
        logger.warn("Manual job scoring failed", {
          jobId: processedJob.id,
          error,
        });
      }
    })().catch((error) => {
      logger.warn("Manual job scoring task failed to start", {
        jobId: processedJob.id,
        error,
      });
    });

    ok(res, processedJob);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});

const batchUrlImportSchema = z.object({
  urls: z
    .array(z.string().trim().url().max(2000))
    .min(1)
    .max(BATCH_URL_IMPORT_MAX_URLS),
});

async function scoreJobAsync(jobId: string): Promise<void> {
  const job = await jobsRepo.getJobById(jobId);
  if (!job) return;
  const brief = await getActivePersonalBrief();
  try {
    const scored = await scoreJobSuitability(job, brief);
    await jobsRepo.updateJob(jobId, {
      suitabilityCategory: scored.category,
      suitabilityReason: scored.reason,
      suitabilityModel: scored.model,
      suitabilityEffort: scored.effort,
    });
  } catch (error) {
    if (error instanceof JobNotScoreableError) {
      // Leave row unscored; user can rescore manually after enriching.
      logger.info("Skipping unscoreable manual job", { jobId });
      return;
    }
    throw error;
  }
}

async function importSingleUrl(
  url: string,
  options: { signal?: AbortSignal; scoringEnabled: boolean },
): Promise<UrlImportOutcome> {
  // Shared fetch+infer head: tier 1/2 programmatic extraction is a verbatim DOM
  // read (skips the tier-3 LLM); otherwise the page text goes to the LLM. Both
  // paths normalize to { job, usage, warning } — usage/warning must survive here
  // for the batch-import result shapes below.
  let inference: Awaited<ReturnType<typeof fetchJobDraft>>;
  try {
    inference = await fetchJobDraft(url, { signal: options.signal });
  } catch (error) {
    const err = toAppError(error);
    return {
      result: {
        ok: false,
        status: "failed",
        url,
        code: err.code,
        message: err.message,
      },
    };
  }

  const draft = inference.job;
  const usage = inference.usage ?? null;
  const title = cleanOptional(draft.title);
  const employer = cleanOptional(draft.employer);
  const jobDescription = cleanOptional(draft.jobDescription);
  if (!title || !employer || !jobDescription) {
    return {
      result: {
        ok: false,
        status: "failed",
        url,
        code: "PARSE_FAILED",
        message:
          inference.warning ||
          "Could not extract title, employer, or description from the page.",
        usage,
      },
      // What WAS read pre-fills the manual form for this row.
      draft,
    };
  }

  return {
    result: await saveImportedJob({
      url,
      draft: { ...draft, title, employer, jobDescription },
      usage,
      scoringEnabled: options.scoringEnabled,
    }),
  };
}

/** A draft whose three required fields are present and trimmed. */
type CompleteJobDraft = ManualJobDraft & {
  title: string;
  employer: string;
  jobDescription: string;
};

/**
 * Create the job a URL import produced — fetched, or finished by hand — or
 * report the one already saved under that URL. The one place both paths go
 * through, so the duplicate lookup, field cleaning and scoring cannot drift.
 */
async function saveImportedJob(args: {
  url: string;
  draft: CompleteJobDraft;
  usage: BatchUrlImportTokenUsage | null;
  scoringEnabled: boolean;
}): Promise<BatchUrlImportItemResult> {
  const { url, draft, usage } = args;
  const { title, employer, jobDescription } = draft;

  const requestedJobUrl =
    cleanOptional(draft.jobUrl) || cleanOptional(draft.applicationLink) || url;
  // Canonicalized here, not only inside `createJob`: the duplicate lookup must
  // see the URL the row would be stored under, or a variant that
  // canonicalization folds (tracking parameters, fragment, host case) misses
  // it and `createJob` hands back the existing row as if it were new.
  const canonicalUrl = canonicalizeJobUrl(requestedJobUrl);

  try {
    // Rows stored before URLs were canonicalized keep their raw URL, so the
    // raw form is looked up too.
    const existing =
      (await jobsRepo.getJobByUrl(canonicalUrl)) ??
      (requestedJobUrl === canonicalUrl
        ? null
        : await jobsRepo.getJobByUrl(requestedJobUrl));
    if (existing) {
      return {
        ok: true,
        status: "duplicate",
        url,
        jobId: existing.id,
        title: existing.title,
        employer: existing.employer,
        usage,
      };
    }

    const created = await jobsRepo.createJob({
      source: "manual",
      title,
      employer,
      jobUrl: canonicalUrl,
      applicationLink: cleanOptional(draft.applicationLink) ?? undefined,
      location: cleanOptional(draft.location) ?? undefined,
      salary: cleanOptional(draft.salary) ?? undefined,
      deadline: cleanOptional(draft.deadline) ?? undefined,
      jobDescription,
      jobType: cleanOptional(draft.jobType) ?? undefined,
      jobLevel: cleanOptional(draft.jobLevel) ?? undefined,
      jobFunction: cleanOptional(draft.jobFunction) ?? undefined,
      disciplines: cleanOptional(draft.disciplines) ?? undefined,
      degreeRequired: cleanOptional(draft.degreeRequired) ?? undefined,
      starting: cleanOptional(draft.starting) ?? undefined,
    });

    if (args.scoringEnabled) {
      void scoreJobAsync(created.id).catch((error) => {
        logger.warn("Batch URL import scoring failed", {
          jobId: created.id,
          error,
        });
      });
    }

    return {
      ok: true,
      status: "created",
      url,
      jobId: created.id,
      title: created.title,
      employer: created.employer,
      usage,
    };
  } catch (error) {
    const err = toAppError(error);
    return {
      ok: false,
      status: "failed",
      url,
      code: err.code,
      message: err.message,
      usage,
    };
  }
}

/**
 * POST /api/manual-jobs/import-batch - Start an import DETACHED from this
 * request, answering with its id. Progress is watched over the stream below by
 * any client, including one that never saw this request.
 */
manualJobsRouter.post("/import-batch", async (req: Request, res: Response) => {
  try {
    const parsed = batchUrlImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(
        res,
        badRequest("Invalid batch URL import request", parsed.error.flatten()),
      );
    }

    // Resolved BEFORE the record exists, so the import's only failure mode is
    // the pool itself and a settings read cannot strand a non-terminal record.
    const scoringEnabled = await isJobScoringEnabled();
    const batchUrlImportConcurrency = (await getEffectiveSettings())
      .batchUrlImportConcurrency.value;

    const urls = Array.from(new Set(parsed.data.urls));
    const started = startUrlImportBatch({
      urls,
      concurrency: batchUrlImportConcurrency,
      importUrl: (url) => importSingleUrl(url, { scoringEnabled }),
    });
    if (!started) {
      return fail(
        res,
        conflict(
          "An import is already running. Stop it before starting another.",
        ),
      );
    }
    // Cannot reject by construction; the catch keeps a future edit to the
    // store from turning that into a process-killer.
    void started.done.catch(() => {});

    logger.info("Batch URL import started", {
      route: "POST /api/manual-jobs/import-batch",
      requested: urls.length,
      concurrency: batchUrlImportConcurrency,
      batchId: started.batchId,
    });

    ok(res, { batchId: started.batchId });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/** GET /api/manual-jobs/import-batch - The retained import, or null. */
manualJobsRouter.get("/import-batch", (_req: Request, res: Response) => {
  ok(res, { batch: getUrlImportBatch() });
});

/**
 * GET /api/manual-jobs/import-batch/stream - Viewer over the one import: a
 * snapshot on connect, then an update per settled URL and at the end. Closing
 * the page cancels nothing.
 */
manualJobsRouter.get("/import-batch/stream", (req: Request, res: Response) => {
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

  const sendEvent = (event: UrlImportBatchStreamEvent) => {
    if (!isWritable()) return;
    writeSseData(res, event);
  };

  sendEvent({ type: "snapshot", batch: getUrlImportBatch(), requestId });
  const unsubscribe = subscribeToUrlImportBatch((batch) => {
    sendEvent({ type: "update", batch, requestId });
  });

  const cleanup = () => {
    clientDisconnected = true;
    stopHeartbeat();
    unsubscribe();
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  res.on("close", () => {
    logger.debug("Batch URL import stream client disconnected", {
      requestId,
    });
    cleanup();
  });
  req.on("close", cleanup);
});

const urlImportDraftQuerySchema = z.object({
  batchId: z.string().min(1),
  url: z.string().min(1),
});

/**
 * GET /api/manual-jobs/import-batch/draft?batchId=&url= - What the fetch read
 * for a failed URL of the retained import, to pre-fill the manual form; null
 * when nothing was read or the import has since been replaced.
 */
manualJobsRouter.get("/import-batch/draft", (req: Request, res: Response) => {
  const parsed = urlImportDraftQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return fail(
      res,
      badRequest("Invalid draft request", parsed.error.flatten()),
    );
  }
  ok(res, {
    draft: getUrlImportDraft(parsed.data.batchId, parsed.data.url),
  });
});

const optionalDraftField = z.string().optional();

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// The row's URL is checked like a URL handed to the batch import, and must
// also be http(s), since the job is stored under it when no usable job URL is
// given. The job's fields are not length-capped, unlike `/import`, because the
// batch import stores fetched fields uncapped and the form is pre-filled from
// them; only the three required ones must be non-empty.
const manualUrlImportSchema = z.object({
  batchId: z.string().min(1),
  url: z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine(isHttpUrl, "Expected an http(s) URL"),
  job: z.object({
    title: z.string().trim().min(1),
    employer: z.string().trim().min(1),
    jobDescription: z.string().trim().min(1),
    jobUrl: optionalDraftField,
    applicationLink: optionalDraftField,
    location: optionalDraftField,
    salary: optionalDraftField,
    deadline: optionalDraftField,
    jobType: optionalDraftField,
    jobLevel: optionalDraftField,
    jobFunction: optionalDraftField,
    disciplines: optionalDraftField,
    degreeRequired: optionalDraftField,
    starting: optionalDraftField,
  }),
});

/**
 * POST /api/manual-jobs/import-batch/manual - A failed row finished by hand.
 * Saves the job the way a fetched one is saved, then marks the row saved in the
 * import it came from — when that import is still the retained one and the row
 * is still failed.
 */
manualJobsRouter.post(
  "/import-batch/manual",
  async (req: Request, res: Response) => {
    try {
      const parsed = manualUrlImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return fail(
          res,
          badRequest("Invalid manual import request", parsed.error.flatten()),
        );
      }
      const { batchId, url, job } = parsed.data;
      const result = await saveImportedJob({
        url,
        // A cleared or malformed job URL falls back to the row's own URL, so
        // the job never lands under a made-up address.
        draft: { ...job, jobUrl: isHttpUrl(job.jobUrl) ? job.jobUrl : url },
        usage: null,
        scoringEnabled: await isJobScoringEnabled(),
      });
      if (!result.ok) {
        return fail(
          res,
          new AppError({
            message: result.message,
            details: { url, code: result.code },
          }),
        );
      }
      resolveUrlImportItem(batchId, url, result);
      ok(res, result);
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

/**
 * POST /api/manual-jobs/import-batch/cancel - Stop dispatching. URLs already
 * being fetched finish; the rest are dropped, so the import settles with
 * `completed` short of `requested`.
 */
manualJobsRouter.post(
  "/import-batch/cancel",
  (_req: Request, res: Response) => {
    const cancelled = cancelUrlImportBatch();
    if (!cancelled) {
      return fail(res, notFound("No import running"));
    }
    ok(res, { cancelled: true });
  },
);
