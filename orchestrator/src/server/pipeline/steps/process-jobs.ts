import { logger } from "@infra/logger";
import { getEffectiveSettings } from "@server/services/settings";
import { asyncPool } from "@server/utils/async-pool";
import { progressHelpers, updateProgress } from "../progress";
import type { ScoredJob } from "./types";

type ProcessJobFn = (
  jobId: string,
  options?: { force?: boolean },
) => Promise<{ success: boolean; error?: string }>;

export async function processJobsStep(args: {
  jobsToProcess: ScoredJob[];
  processJob: ProcessJobFn;
  shouldCancel?: () => boolean;
}): Promise<{ processedCount: number }> {
  let processedCount = 0;

  if (args.jobsToProcess.length > 0) {
    const total = args.jobsToProcess.length;
    let startedCount = 0;
    let completedCount = 0;

    const tailoringConcurrency = (await getEffectiveSettings())
      .tailoringConcurrency.value;

    updateProgress({
      step: "processing",
      jobsProcessed: 0,
      totalToProcess: total,
    });

    await asyncPool({
      items: args.jobsToProcess,
      concurrency: tailoringConcurrency,
      shouldStop: args.shouldCancel,
      onTaskStarted: (job) => {
        startedCount += 1;
        progressHelpers.processingJob(startedCount, total, job);
      },
      onTaskSettled: (_job, _index) => {
        completedCount += 1;
        progressHelpers.jobComplete(completedCount, total);
      },
      task: async (job) => {
        const result = await args.processJob(job.id, {
          force: false,
        });
        if (result.success) {
          processedCount += 1;
        } else {
          logger.warn("Failed to process job", {
            jobId: job.id,
            error: result.error,
          });
        }
        return result;
      },
    });
  }

  return { processedCount };
}
