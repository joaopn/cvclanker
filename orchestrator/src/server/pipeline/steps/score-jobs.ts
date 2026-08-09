import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import * as settingsRepo from "@server/repositories/settings";
import {
  JobNotScoreableError,
  scoreJobSuitability,
} from "@server/services/scorer";
import { getEffectiveSettings } from "@server/services/settings";
import { asyncPool } from "@server/utils/async-pool";
import {
  SUITABILITY_CATEGORIES,
  SUITABILITY_CATEGORY_RANK,
  type Job,
  type SuitabilityCategory,
} from "@shared/types";
import { progressHelpers, updateProgress } from "../progress";
import type { ScoredJob } from "./types";

function parseCategoryOrNull(
  raw: string | null | undefined,
): SuitabilityCategory | null {
  if (!raw) return null;
  return (SUITABILITY_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as SuitabilityCategory)
    : null;
}

export async function scoreJobsStep(args: {
  brief: string;
  shouldCancel?: () => boolean;
}): Promise<{ unprocessedJobs: Job[]; scoredJobs: ScoredJob[] }> {
  const enableJobScoringRaw =
    await settingsRepo.getSetting("enableJobScoring");
  const scoringEnabled = enableJobScoringRaw === null
    ? true
    : enableJobScoringRaw === "1" || enableJobScoringRaw === "true";

  if (!scoringEnabled) {
    logger.info("Scoring step disabled by setting");
    return { unprocessedJobs: [], scoredJobs: [] };
  }

  logger.info("Running scoring step");
  const unprocessedJobs = await jobsRepo.getUnscoredDiscoveredJobs();

  const autoSkipCategory = parseCategoryOrNull(
    await settingsRepo.getSetting("autoSkipCategory"),
  );
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

      let category: SuitabilityCategory;
      let reason: string;
      try {
        ({ category, reason } = await scoreJobSuitability(job, args.brief));
      } catch (error) {
        if (error instanceof JobNotScoreableError) {
          // Skip — leave the row unscored. The user will see "Unscored" in
          // the UI; they can re-fetch the URL to enrich the description or
          // manually trigger rescore once it's populated.
          logger.info("Skipping unscoreable job (short/empty description)", {
            jobId: job.id,
            title: job.title,
          });
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
      if (args.shouldCancel?.()) return;

      const shouldAutoSkip =
        job.status !== "applied" &&
        autoSkipCategory !== null &&
        SUITABILITY_CATEGORY_RANK[category] <=
          SUITABILITY_CATEGORY_RANK[autoSkipCategory];

      await jobsRepo.updateJob(job.id, {
        suitabilityCategory: category,
        suitabilityReason: reason,
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

      completed += 1;
      progressHelpers.scoringJob(completed, unprocessedJobs.length, job.title);
      scoredJobs.push({
        ...job,
        suitabilityCategory: category,
        suitabilityReason: reason,
      });
    },
  });

  progressHelpers.scoringComplete(scoredJobs.length);
  logger.info("Scoring step completed", {
    scoredJobs: scoredJobs.length,
    concurrency: scoringConcurrency,
  });

  return { unprocessedJobs, scoredJobs };
}
