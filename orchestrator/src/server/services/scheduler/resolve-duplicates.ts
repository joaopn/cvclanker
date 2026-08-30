import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import { startJobActionBatch } from "@server/services/job-actions/batch-store";
import { getEffectiveSettings } from "@server/services/settings";
import { losersOf } from "@shared/duplicate-resolution";
import type { JobStatus } from "@shared/types";

/**
 * Close the extra copies of duplicate groups, after a scheduled run.
 *
 * This overrides the standing "never auto-merge" rule FOR SCHEDULES THAT OPT
 * IN, and only for the safest groups. The governing rule everywhere else still
 * holds: prefer extra duplicates over incorrectly joining two jobs, because a
 * missed duplicate costs an inbox row while a wrong join destroys a real
 * opening. There is NO server-side undo — the wizard's undo is a client
 * snapshot — so a wrongly closed row is recoverable only by hand.
 *
 * Three narrowings, each load-bearing:
 *  - `bulkSafe` groups ONLY. A group whose rows disagree about the job title
 *    needs a human; those keep waiting, on every schedule, always.
 *  - Groups holding a LIVE tailor are skipped entirely. `runProcessJob`
 *    captures the row's status at entry and writes `ready` when it finishes,
 *    so a row closed mid-tailor comes back a minute later — the close would
 *    silently undo itself (see B60).
 *  - Whole groups only, batched under `maxBulkActionJobs`. Half a closed group
 *    leaves copies that no longer read as duplicates to anyone.
 */
/**
 * The statuses `mark_duplicated` accepts. Mirrors `DUPLICATE_FROM_STATUSES` in
 * the jobs route, which mirrors `DUPLICATE_SCOPE_STATUSES` in the repository —
 * the three must agree, or this starts closing rows the action would refuse.
 */
const CLOSEABLE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "discovered",
  "selected",
  "processing",
  "ready",
]);

export async function resolveDuplicatesForSchedule(): Promise<number> {
  const groups = await jobsRepo.getDuplicateGroups();
  const settings = await getEffectiveSettings();
  const cap = settings.maxBulkActionJobs.value;

  const sweepable = groups.filter(
    (group) =>
      group.bulkSafe &&
      // `processing` with NO failure reason is a tailor running right now.
      // With a reason it is a failed tailor, which is inert and safe to close.
      !group.jobs.some(
        (job) =>
          job.status === "processing" && job.tailoringFailureReason === null,
      ),
  );

  const losersByGroup = sweepable
    .map((group) => losersOf(group, {}).map((job) => job.id))
    .filter((losers) => losers.length > 0);
  if (losersByGroup.length === 0) return 0;

  // Batched WHOLE GROUPS under the cap. Splitting a group across batches would
  // leave copies behind that no longer read as duplicates to anyone, so a
  // single group larger than the cap is taken whole and exceeds it. That is
  // NOT what the review wizard does — its request is refused outright by the
  // route's size gate — and this path is the only caller that can go over,
  // because it bypasses the routes.
  const batches: string[][] = [];
  for (const losers of losersByGroup) {
    const current = batches.at(-1);
    if (!current || current.length + losers.length > cap) {
      batches.push([...losers]);
      continue;
    }
    current.push(...losers);
  }

  let closed = 0;
  for (const jobIds of batches) {
    // Through the batch registry rather than a bare loop of writes: that is
    // what `hasRunningJobActionBatches()` reads, and it is one of the guards
    // that stops the active User-Profile database being closed and swapped
    // underneath a sweep in progress.
    const { done } = startJobActionBatch({
      action: "mark_duplicated",
      jobIds,
      concurrency: 1,
      // Nobody may truncate this: the sweep is the run's, not a viewer's.
      cancellable: false,
      // Results are needed to count what actually closed, and a detached batch
      // discards them by default.
      retainResults: true,
      // Per-item failures are RETURNED, never thrown: a throw out of `runJob`
      // is treated as a batch-level failure and abandons every row after it,
      // where one row that cannot be closed should cost only that row.
      runJob: async (jobId) => {
        try {
          // RE-READ before writing. The group snapshot is taken once, and every
          // write after it is against data that may have moved: a row the user
          // promoted to Live in the meantime is the record of what was actually
          // sent, and a tailor started after the snapshot is not in it. This is
          // the same guard the `mark_duplicated` action applies, applied here
          // because this path writes the row directly.
          const current = await jobsRepo.getJobById(jobId);
          if (!current) {
            return {
              jobId,
              ok: false as const,
              error: { code: "NOT_FOUND", message: "Job not found" },
            };
          }
          if (!CLOSEABLE_STATUSES.has(current.status)) {
            return {
              jobId,
              ok: false as const,
              error: {
                code: "CONFLICT",
                message: `Job moved to "${current.status}" since the sweep began`,
              },
            };
          }
          if (
            current.status === "processing" &&
            current.tailoringFailureReason === null
          ) {
            return {
              jobId,
              ok: false as const,
              error: {
                code: "CONFLICT",
                message: "A tailor started on this job since the sweep began",
              },
            };
          }
          const job = await jobsRepo.updateJob(jobId, {
            status: "closed",
            outcome: "duplicated",
            closedAt: Math.floor(Date.now() / 1000),
          });
          if (!job) {
            return {
              jobId,
              ok: false as const,
              error: { code: "NOT_FOUND", message: "Job not found" },
            };
          }
          return { jobId, ok: true as const, job };
        } catch (error) {
          return {
            jobId,
            ok: false as const,
            error: {
              code: "INTERNAL_ERROR",
              message: error instanceof Error ? error.message : "Unknown error",
            },
          };
        }
      },
    });
    const outcome = await done;
    const succeeded = outcome.results.filter((result) => result.ok).length;
    closed += succeeded;
    const failed = outcome.results.length - succeeded;
    if (failed > 0 || outcome.error) {
      // One unclosable row must not abandon the rest of the sweep.
      logger.warn("Some duplicates could not be auto-closed", {
        failed,
        reason: outcome.error?.message ?? null,
      });
    }
  }

  return closed;
}
