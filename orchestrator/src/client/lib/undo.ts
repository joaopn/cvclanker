/**
 * Shared undo helpers. In-scope triage operations mutate
 * `status` / `outcome` / `closedAt`, and `PATCH /api/jobs/:id` writes those
 * directly with no transition guards — so undo is "snapshot those fields
 * before the op, PATCH them back after".
 *
 * `appliedAt` rides along because it is STICKY: the server stamps it on the
 * first move to Applied/Interviewing and nothing else can clear it. Without it
 * here, undoing a mis-pressed "Mark applied" (or a mis-clicked Move to
 * Interviewing) put the row back where it was while leaving a permanent,
 * unclearable Applied badge on it — the mark would claim an application that
 * never happened. Restoring the prior value is what makes undo mean "this
 * action did not happen"; the mark stays permanent against everything else.
 */

import * as api from "@client/api";
import type { Job, JobListItem, JobOutcome, JobStatus } from "@shared/types.js";

export interface JobStateSnapshot {
  jobId: string;
  status: JobStatus;
  outcome: JobOutcome | null;
  closedAt: number | null;
  appliedAt: string | null;
}

/** Capture the reversible triage fields off a job (full or list item). */
export const snapshotJob = (job: Job | JobListItem): JobStateSnapshot => ({
  jobId: job.id,
  status: job.status,
  outcome: job.outcome,
  closedAt: job.closedAt,
  appliedAt: job.appliedAt ?? null,
});

export interface RestoreResult {
  restored: number;
  failed: number;
}

/** Restore each snapshot via PATCH; best-effort (never rejects). */
export const restoreJobStates = async (
  snapshots: JobStateSnapshot[],
): Promise<RestoreResult> => {
  const outcomes = await Promise.allSettled(
    snapshots.map((snap) =>
      api.updateJob(snap.jobId, {
        status: snap.status,
        outcome: snap.outcome,
        closedAt: snap.closedAt,
        appliedAt: snap.appliedAt,
      }),
    ),
  );
  const failed = outcomes.filter((o) => o.status === "rejected").length;
  return { restored: outcomes.length - failed, failed };
};
