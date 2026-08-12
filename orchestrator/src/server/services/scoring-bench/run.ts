/**
 * Runs the real scoring path over a random sample of jobs under several model
 * configurations, and keeps every result in memory. Nothing here writes to the
 * database: the whole point is to compare classifiers without touching the
 * jobs the user is actually working.
 */

import { logger } from "@infra/logger";
import { getPipelineStatus } from "@server/pipeline/index";
import * as jobsRepo from "@server/repositories/jobs";
import { getActivePersonalBrief } from "@server/services/brief";
import { resetRateLimitBudget } from "@server/services/llm/rate-limit-budget";
import { resolveLlmModel } from "@server/services/modelSelection";
import {
  classifyJob,
  LlmRateLimitStopError,
  MIN_SCOREABLE_DESCRIPTION_CHARS,
} from "@server/services/scorer";
import { getEffectiveSettings } from "@server/services/settings";
import { asyncPool } from "@server/utils/async-pool";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  type ClaudeCodeEffortLevel,
} from "@shared/settings-registry";
import type {
  BenchCell,
  BenchConfig,
  BenchJob,
  BenchRun,
  Job,
} from "@shared/types";
import {
  finishBenchRun,
  getBenchStopReason,
  isBenchStopRequested,
  recordBenchCell,
  requestBenchStop,
  setBenchRunConfigs,
  setBenchRunJobs,
} from "./store";

type Cursor = { job: Job; config: BenchConfig };

function parseEffortLevel(value: unknown): ClaudeCodeEffortLevel | null {
  return typeof value === "string" &&
    (CLAUDE_CODE_EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as ClaudeCodeEffortLevel)
    : null;
}

function toBenchJob(job: Job): BenchJob {
  return {
    id: job.id,
    title: job.title,
    employer: job.employer,
    jobUrl: job.jobUrl ?? null,
  };
}

/**
 * Draw the sample and classify it. The caller has already claimed the run
 * synchronously; this fills it in and must therefore always finish it, or the
 * store stays "running" forever and every later request 409s.
 */
export async function executeBenchRun(args: {
  run: BenchRun;
  sampleSize: number;
}): Promise<void> {
  const { run, sampleSize } = args;

  try {
    const [settings, brief, configuredModel] = await Promise.all([
      getEffectiveSettings(),
      getActivePersonalBrief(),
      resolveLlmModel("scoring"),
    ]);

    // A latch left over from an earlier session limit must not silently fail
    // every cell of a run the user just asked for — the same fresh-attempt
    // reset the pipeline run route performs. Skipped while a pipeline is
    // running, because there the latch is holding back a queue that is still
    // live, and clearing it from here would restart someone else's halted work.
    if (!getPipelineStatus().isRunning) {
      resetRateLimitBudget(settings.llmRateLimitRetries.value);
    }

    const instructions = settings.scoringInstructions?.value ?? "";
    const concurrency = settings.scoringConcurrency.value;

    // Record what will actually be sent: a blank model means "the model scoring
    // uses today", and on claude_code a blank effort means the saved
    // `claudeCodeEffort` (which reaches the CLI through the environment). Both
    // are resolved here so the grid's column headers cannot claim otherwise.
    const configuredEffort =
      settings.llmProvider?.value === "claude_code"
        ? parseEffortLevel(settings.claudeCodeEffort)
        : null;
    const resolvedConfigs = run.configs.map((config) => ({
      ...config,
      model: config.model.trim() || configuredModel,
      effort: config.effort ?? configuredEffort,
    }));
    setBenchRunConfigs(run.id, resolvedConfigs);

    const sample = await jobsRepo.getRandomScoreableJobs({
      limit: sampleSize,
      minDescriptionChars: MIN_SCOREABLE_DESCRIPTION_CHARS,
    });
    setBenchRunJobs(run.id, sample.map(toBenchJob));

    if (sample.length === 0) {
      logger.info("Model benchmark drew an empty sample", { runId: run.id });
      finishBenchRun(run.id, "done");
      return;
    }

    // Job-major so a row fills across all its configs before the next row
    // starts — the grid fills top-down instead of column-by-column.
    const cursors: Cursor[] = sample.flatMap((job) =>
      resolvedConfigs.map((config) => ({ job, config })),
    );

    logger.info("Model benchmark started", {
      runId: run.id,
      jobs: sample.length,
      configs: resolvedConfigs.length,
      calls: cursors.length,
      concurrency,
    });

    await asyncPool<Cursor, void>({
      items: cursors,
      concurrency,
      shouldStop: isBenchStopRequested,
      task: async ({ job, config }) => {
        if (isBenchStopRequested()) return;

        recordBenchCell(run.id, blankCell(job.id, config.id, "running"));
        const startedAt = Date.now();

        try {
          const result = await classifyJob(job, brief, {
            model: config.model,
            instructions,
            ...(config.effort ? { effort: config.effort } : {}),
          });
          recordBenchCell(run.id, {
            ...blankCell(job.id, config.id, "done"),
            category: result.category,
            reason: result.reason,
            promptTokens: result.usage?.promptTokens ?? null,
            completionTokens: result.usage?.completionTokens ?? null,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          recordBenchCell(run.id, {
            ...blankCell(job.id, config.id, "error"),
            error: message,
            durationMs: Date.now() - startedAt,
          });
          // A rate limit is account-wide: every remaining cell would hit the
          // same wall, so stop the whole run rather than filling the grid with
          // identical failures.
          if (error instanceof LlmRateLimitStopError) {
            requestBenchStop(message);
          }
        }
      },
    });

    const stopReason = getBenchStopReason();
    if (stopReason) finishBenchRun(run.id, "stopped", stopReason);
    else if (isBenchStopRequested()) finishBenchRun(run.id, "cancelled");
    else finishBenchRun(run.id, "done");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Model benchmark failed", { runId: run.id, error: message });
    finishBenchRun(run.id, "stopped", message);
  }
}

function blankCell(
  jobId: string,
  configId: string,
  status: BenchCell["status"],
): BenchCell {
  return {
    jobId,
    configId,
    status,
    category: null,
    reason: null,
    error: null,
    promptTokens: null,
    completionTokens: null,
    durationMs: null,
  };
}
