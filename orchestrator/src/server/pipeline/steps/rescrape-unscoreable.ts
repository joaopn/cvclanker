import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import {
  getRateLimitStopReason,
  isRateLimitStopped,
} from "@server/services/llm/rate-limit-budget";
import { fetchJobDraft } from "@server/services/manualJob";
import {
  buildRescrapeUpdate,
  isRescrapableUrl,
  trimToNull,
} from "@server/services/rescrape-job";
import {
  LlmRateLimitStopError,
  MIN_SCOREABLE_DESCRIPTION_CHARS,
} from "@server/services/scorer";
import { getEffectiveSettings } from "@server/services/settings";
import { asyncPool } from "@server/utils/async-pool";
import type { Job, SuitabilityCategory } from "@shared/types";
import { updateProgress } from "../progress";
import { scoreAndSaveJob } from "./score-jobs";
import type { ScoredJob } from "./types";

/**
 * Re-fetch the posting page of each job the scoring step could not score for
 * a too-short description, save what the page says and score the job. One try
 * per job. A failed fetch leaves the job as it was; a failed score after a
 * successful fetch keeps the new description and leaves the job unscored.
 * Only a provider rate limit ends the run.
 */
export async function rescrapeUnscoreableStep(args: {
  jobs: Job[];
  brief: string;
  autoSkipCategory: SuitabilityCategory | null;
  shouldCancel?: () => boolean;
}): Promise<ScoredJob[]> {
  const jobs = args.jobs.filter((job) => isRescrapableUrl(job.jobUrl));
  if (jobs.length === 0) return [];

  logger.info("Re-fetching unscoreable jobs", { jobs: jobs.length });
  const concurrency = (await getEffectiveSettings()).bulkActionConcurrency
    .value;

  const scoredJobs: ScoredJob[] = [];
  let done = 0;

  await asyncPool({
    items: jobs,
    concurrency,
    shouldStop: args.shouldCancel,
    task: async (listed) => {
      if (args.shouldCancel?.()) return;

      try {
        // The list was read when scoring started; the user may have tailored,
        // skipped or moved the job since.
        const job = await jobsRepo.getJobById(listed.id);
        if (
          !job ||
          job.status !== "discovered" ||
          job.suitabilityCategory != null
        ) {
          return;
        }

        const { job: draft } = await fetchJobDraft(job.jobUrl);
        // The page reader reports a rate limit as an empty draft, so read the
        // account-wide latch instead.
        if (isRateLimitStopped()) {
          throw new LlmRateLimitStopError({
            jobId: job.id,
            reason: getRateLimitStopReason() ?? "rate limited",
          });
        }
        const description = trimToNull(draft.jobDescription) ?? "";
        if (description.length < MIN_SCOREABLE_DESCRIPTION_CHARS) return;

        const updated = await jobsRepo.updateJob(
          job.id,
          buildRescrapeUpdate(job, draft),
        );
        if (!updated || updated.status !== "discovered") return;

        const scored = await scoreAndSaveJob({
          job: updated,
          brief: args.brief,
          autoSkipCategory: args.autoSkipCategory,
          shouldCancel: args.shouldCancel,
        });
        if (scored) scoredJobs.push(scored);
      } catch (error) {
        if (error instanceof LlmRateLimitStopError) throw error;
        logger.warn("Re-fetching an unscoreable job failed", {
          jobId: listed.id,
          title: listed.title,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        done += 1;
        updateProgress({
          step: "scoring",
          message: `Re-fetching jobs (${done}/${jobs.length})...`,
          detail: listed.title,
        });
      }
    },
  });

  logger.info("Re-fetching unscoreable jobs finished", {
    jobs: jobs.length,
    scored: scoredJobs.length,
  });
  return scoredJobs;
}
