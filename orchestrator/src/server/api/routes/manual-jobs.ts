import { randomUUID } from "node:crypto";
import { AppError, badRequest, notFound, toAppError } from "@infra/errors";
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
import { asyncPool } from "@server/utils/async-pool";
import type {
  BatchUrlImportItemResult,
  BatchUrlImportStreamEvent,
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
          message:
            processResult.error ||
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

const BATCH_URL_IMPORT_MAX_URLS = 50;

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
): Promise<BatchUrlImportItemResult> {
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
      ok: false,
      status: "failed",
      url,
      code: err.code,
      message: err.message,
    };
  }

  const draft = inference.job;
  const title = cleanOptional(draft.title);
  const employer = cleanOptional(draft.employer);
  const jobDescription = cleanOptional(draft.jobDescription);
  const usage = inference.usage ?? null;

  if (!title || !employer || !jobDescription) {
    return {
      ok: false,
      status: "failed",
      url,
      code: "PARSE_FAILED",
      message:
        inference.warning ||
        "Could not extract title, employer, or description from the page.",
      usage,
    };
  }

  const canonicalUrl =
    cleanOptional(draft.jobUrl) || cleanOptional(draft.applicationLink) || url;

  try {
    const existing = await jobsRepo.getJobByUrl(canonicalUrl);
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

    if (options.scoringEnabled) {
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
 * POST /api/manual-jobs/import-batch/stream - Fetch + import a batch of job URLs
 * with live SSE progress.
 */
manualJobsRouter.post(
  "/import-batch/stream",
  async (req: Request, res: Response) => {
    const parsed = batchUrlImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(
        res,
        badRequest(
          "Invalid batch URL import request",
          parsed.error.flatten(),
        ),
      );
    }

    const dedupedUrls = Array.from(new Set(parsed.data.urls));
    const requestId = String(res.getHeader("x-request-id") || "unknown");
    const requested = dedupedUrls.length;
    const results: BatchUrlImportItemResult[] = [];
    let succeeded = 0;
    let duplicates = 0;
    let failed = 0;

    setupSse(res, {
      cacheControl: "no-cache, no-transform",
      disableBuffering: true,
      flushHeaders: true,
    });
    const stopHeartbeat = startSseHeartbeat(res);

    let clientDisconnected = false;
    res.on("close", () => {
      clientDisconnected = true;
      stopHeartbeat();
    });

    const isResponseWritable = () =>
      !clientDisconnected && !res.writableEnded && !res.destroyed;

    const sendEvent = (event: BatchUrlImportStreamEvent) => {
      if (!isResponseWritable()) return false;
      writeSseData(res, event);
      return true;
    };

    try {
      const scoringEnabled = await isJobScoringEnabled();
      const batchUrlImportConcurrency = (await getEffectiveSettings())
        .batchUrlImportConcurrency.value;

      if (!sendEvent({ type: "started", requested, requestId })) {
        logger.info("Client disconnected before batch URL import started", {
          route: "POST /api/manual-jobs/import-batch/stream",
          requested,
          requestId,
        });
        return;
      }

      await asyncPool({
        items: dedupedUrls,
        concurrency: batchUrlImportConcurrency,
        shouldStop: () => !isResponseWritable(),
        task: async (url) => {
          if (!isResponseWritable()) return;

          const result = await importSingleUrl(url, { scoringEnabled });
          results.push(result);
          if (result.ok && result.status === "created") succeeded += 1;
          else if (result.ok && result.status === "duplicate") duplicates += 1;
          else failed += 1;

          if (
            !sendEvent({
              type: "progress",
              result,
              completed: results.length,
              succeeded,
              duplicates,
              failed,
              requestId,
            })
          ) {
            logger.info(
              "Client disconnected during batch URL import progress",
              {
                route: "POST /api/manual-jobs/import-batch/stream",
                requested,
                succeeded,
                duplicates,
                failed,
                requestId,
              },
            );
          }
        },
      });

      sendEvent({
        type: "completed",
        results,
        succeeded,
        duplicates,
        failed,
        requestId,
      });

      logger.info("Batch URL import stream completed", {
        route: "POST /api/manual-jobs/import-batch/stream",
        requested,
        succeeded,
        duplicates,
        failed,
        concurrency: batchUrlImportConcurrency,
        requestId,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error("Batch URL import stream failed", {
        route: "POST /api/manual-jobs/import-batch/stream",
        requested,
        succeeded,
        duplicates,
        failed,
        status: err.status,
        code: err.code,
        requestId,
      });

      sendEvent({
        type: "error",
        code: err.code,
        message: err.message,
        requestId,
      });
    } finally {
      stopHeartbeat();
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  },
);
