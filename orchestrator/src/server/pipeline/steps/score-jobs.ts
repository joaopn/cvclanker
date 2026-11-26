import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import * as settingsRepo from "@server/repositories/settings";
import {
  JobNotScoreableError,
  JobScoringFailedError,
  LlmRateLimitStopError,
  scoreJobSuitability,
} from "@server/services/scorer";
import { getEffectiveSettings } from "@server/services/settings";
import { asyncPool } from "@server/utils/async-pool";
import {
  type Job,
  SUITABILITY_CATEGORY_RANK,
  type SuitabilityCategory,
} from "@shared/types";
import { progressHelpers, updateProgress } from "../progress";
import type { ScoredJob } from "./types";

/**
 * Score one job with the pre-filter, apply the run's auto-skip tier and save
 * the verdict. Throws whatever the scorer throws (`JobNotScoreableError`,
 * `JobScoringFailedError`, `LlmRateLimitStopError`); the caller decides what
 * each means. Returns null when the run was cancelled while the job was being
 * scored, in which case nothing is saved.
 */
export async function scoreAndSaveJob(args: {
  job: Job;
  brief: string;
  autoSkipCategory: SuitabilityCategory | null;
  shouldCancel?: () => boolean;
}): Promise<ScoredJob | null> {
  const { job, autoSkipCategory } = args;
  // The one path that opts into the cheap pre-filter: it classifies
  // everything discovery finds, which is the only place the saving is
  // worth the risk of a screen removing a job.
  const scored = await scoreJobSuitability(job, args.brief, {
    prefilter: true,
  });
  if (args.shouldCancel?.()) return null;

  const { category, reason } = scored;
  // The permanent applied mark, not the status: every row here is
  // `discovered`, and a reopened job you applied for keeps the mark.
  const shouldAutoSkip =
    job.appliedAt === null &&
    autoSkipCategory !== null &&
    SUITABILITY_CATEGORY_RANK[category] <=
      SUITABILITY_CATEGORY_RANK[autoSkipCategory];

  await jobsRepo.updateJob(job.id, {
    suitabilityCategory: category,
    suitabilityReason: reason,
    suitabilityModel: scored.model,
    suitabilityEffort: scored.effort,
    ...(shouldAutoSkip ? { status: "skipped" } : {}),
  });

  if (shouldAutoSkip) {
    logger.info("Auto-skipped job due to low category", {
      jobId: job.id,
      title: job.title,
      category,
      autoSkipCategory,
    });
  }

  return {
    ...job,
    suitabilityCategory: category,
    suitabilityReason: reason,
    suitabilityModel: scored.model,
    suitabilityEffort: scored.effort,
  };
}

export async function scoreJobsStep(args: {
  brief: string;
  /** The run's resolved auto-skip tier; null skips nothing. */
  autoSkipCategory: SuitabilityCategory | null;
  shouldCancel?: () => boolean;
}): Promise<{
  unprocessedJobs: Job[];
  scoredJobs: ScoredJob[];
  /** Jobs left unscored because their description was too short. */
  unscoreableJobs: Job[];
}> {
  const enableJobScoringRaw = await settingsRepo.getSetting("enableJobScoring");
  const scoringEnabled =
    enableJobScoringRaw === null
      ? true
      : enableJobScoringRaw === "1" || enableJobScoringRaw === "true";

  if (!scoringEnabled) {
    logger.info("Scoring step disabled by setting");
    return { unprocessedJobs: [], scoredJobs: [], unscoreableJobs: [] };
  }

  logger.info("Running scoring step");
  const unprocessedJobs = await jobsRepo.getUnscoredDiscoveredJobs();

  const { autoSkipCategory } = args;
  const scoringConcurrency = (await getEffectiveSettings()).scoringConcurrency
    .value;

  updateProgress({
    step: "scoring",
    jobsDiscovered: unprocessedJobs.length,
    jobsScored: 0,
    jobsProcessed: 0,
    totalToProcess: 0,
    currentJob: undefined,
  });

  const scoredJobs: ScoredJob[] = [];
  const unscoreableJobs: Job[] = [];
  let completed = 0;

  await asyncPool({
    items: unprocessedJobs,
    concurrency: scoringConcurrency,
    shouldStop: args.shouldCancel,
    task: async (job) => {
      if (args.shouldCancel?.()) return;

      if (job.suitabilityCategory) {
        completed += 1;
        progressHelpers.scoringJob(
          completed,
          unprocessedJobs.length,
          `${job.title} (cached)`,
        );
        scoredJobs.push({
          ...job,
          suitabilityCategory: job.suitabilityCategory,
          suitabilityReason: job.suitabilityReason ?? "",
        });
        return;
      }

      let scored: ScoredJob | null;
      try {
        scored = await scoreAndSaveJob({
          job,
          brief: args.brief,
          autoSkipCategory,
          shouldCancel: args.shouldCancel,
        });
      } catch (error) {
        if (error instanceof LlmRateLimitStopError) {
          // Account-wide and temporary: every remaining job would hit the same
          // wall, so end the whole run rather than burn through the queue
          // leaving each row unscored.
          logger.error("Scoring stopped by provider rate limit", {
            jobId: job.id,
            error: error.message,
          });
          throw error;
        }
        if (error instanceof JobScoringFailedError) {
          // This job alone failed — leave it unscored and move on. A missing
          // score is honest; a fabricated one is not.
          logger.warn("Leaving job unscored after a scoring failure", {
            jobId: job.id,
            title: job.title,
            error: error.message,
          });
          completed += 1;
          progressHelpers.scoringJob(
            completed,
            unprocessedJobs.length,
            `${job.title} (scoring failed)`,
          );
          return;
        }
        if (error instanceof JobNotScoreableError) {
          // Skip — leave the row unscored. The user will see "Unscored" in
          // the UI; they can re-fetch the URL to enrich the description or
          // manually trigger rescore once it's populated.
          logger.info("Skipping unscoreable job (short/empty description)", {
            jobId: job.id,
            title: job.title,
          });
          unscoreableJobs.push(job);
          completed += 1;
          progressHelpers.scoringJob(
            completed,
            unprocessedJobs.length,
            `${job.title} (unscoreable)`,
          );
          return;
        }
        throw error;
      }
      if (scored === null) return;

      completed += 1;
      progressHelpers.scoringJob(completed, unprocessedJobs.length, job.title);
      scoredJobs.push(scored);
    },
  });

  progressHelpers.scoringComplete(scoredJobs.length);
  logger.info("Scoring step completed", {
    scoredJobs: scoredJobs.length,
    concurrency: scoringConcurrency,
  });

  return { unprocessedJobs, scoredJobs, unscoreableJobs };
}
