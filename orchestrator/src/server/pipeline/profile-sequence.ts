import { logger } from "@infra/logger";
import type { PipelineConfig } from "@shared/types";
import { requestPipelineCancel, runPipeline } from "./orchestrator";
import { progressHelpers, setActiveProfileRun } from "./progress";
import {
  endProfileSequence,
  isProfileSequenceCancelRequested,
} from "./sequence-state";

export interface ProfileSequenceEntry {
  profile: { id: string; name: string };
  config: Partial<PipelineConfig>;
}

/**
 * Run several Search Profiles through the pipeline one after another.
 *
 * The caller MUST already hold the sequence claim (`tryBeginProfileSequence`),
 * taken synchronously before any await; this function releases it in `finally`.
 *
 * Finality is declared here, not derived by the client: every event emitted
 * while the chain runs carries the active profile context, so each profile's
 * own terminal reads as "one profile ended", and exactly one aggregate terminal
 * is emitted at the end with the context cleared. That is what lets a cancelled
 * or crashed chain still close out the run on the client.
 *
 * A profile that fails does NOT abort the chain — the profiles are independent
 * runs. A cancel does.
 */
export async function runProfileSequence(
  entries: ProfileSequenceEntry[],
): Promise<void> {
  const total = entries.length;
  let completed = 0;
  let failed = 0;
  let stopped = 0;
  let cancelled = false;

  try {
    for (const [index, entry] of entries.entries()) {
      // Must be the LAST synchronous statement before the run starts, together
      // with the re-assert below: `runPipeline` clears the orchestrator's
      // cancel flag at entry, so a cancel landing in this window would
      // otherwise be wiped and the profile would run to completion after the
      // user was told the cancellation was accepted.
      if (isProfileSequenceCancelRequested()) {
        cancelled = true;
        break;
      }

      setActiveProfileRun({
        id: entry.profile.id,
        name: entry.profile.name,
        index: index + 1,
        total,
      });

      // `runPipeline` sets its running flag and clears its cancel flag
      // synchronously before its first await, so re-asserting immediately after
      // the call — with no await in between — closes the commit window.
      const running = runPipeline(entry.config);
      if (isProfileSequenceCancelRequested()) {
        requestPipelineCancel();
      }

      try {
        const result = await running;
        if (result.success) {
          completed += 1;
        } else if (isProfileSequenceCancelRequested()) {
          // The user stopped this one; reporting it as "failed" would blame
          // the run for doing what it was told.
          stopped += 1;
        } else {
          // Non-success is a RETURN VALUE here, not a throw (notably the
          // "Pipeline is already running" singleton rejection), so it would be
          // invisible to a catch-only guard.
          failed += 1;
          logger.warn("Profile run finished unsuccessfully", {
            profileId: entry.profile.id,
            error: result.error,
          });
        }
      } catch (error) {
        // Mirrors the return arm above: `runPipeline` converts a cancellation
        // into a non-success return today, so this is belt-and-braces, but the
        // two arms must not disagree about what a cancel means.
        if (isProfileSequenceCancelRequested()) {
          stopped += 1;
        } else {
          failed += 1;
        }
        logger.error("Profile run threw", {
          profileId: entry.profile.id,
          error,
        });
      }

      if (isProfileSequenceCancelRequested()) {
        cancelled = true;
        break;
      }
    }
  } finally {
    // State first, emit last. If the emit threw with the flag still set,
    // `getPipelineStatus` would report a run in progress forever: every User
    // Profile switch rejected, the CLI updater blocked, `/run` 409ing, and a
    // client stuck mid-run — recoverable only by restarting the container.
    // All of these are synchronous, so the reordering opens no window.
    endProfileSequence();
    setActiveProfileRun(null);
    progressHelpers.sequenceFinished(
      summarize({ total, completed, failed, stopped, cancelled }),
    );
  }
}

function summarize(counts: {
  total: number;
  completed: number;
  failed: number;
  stopped: number;
  cancelled: boolean;
}): {
  status: "completed" | "cancelled" | "failed";
  message: string;
  detail: string;
  error?: string;
} {
  const { total, completed, failed, stopped, cancelled } = counts;
  const notStarted = total - completed - failed - stopped;
  // Every clause is omitted at zero — a cancel landing in the final gap has
  // nothing left unstarted, and a chain with no failures shouldn't say so.
  const detail = [
    `${completed} of ${total} profiles completed`,
    failed > 0 ? `${failed} failed` : null,
    stopped > 0 ? `${stopped} stopped` : null,
    notStarted > 0 ? `${notStarted} not started` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (cancelled) {
    return {
      status: "cancelled",
      message: `Multi-profile run cancelled after ${completed + failed + stopped} of ${total} profiles`,
      detail,
    };
  }

  // A mixed chain reports `completed`: it is the step that drives the success
  // toast and the Swipe deck's refetch, and a chain where some profiles
  // imported jobs must not look like a total failure. `failed` is reserved for
  // "nothing succeeded".
  if (completed > 0) {
    return {
      status: "completed",
      message: `Multi-profile run complete (${completed}/${total} profiles)`,
      detail,
    };
  }

  const error = `All ${total} profiles failed`;
  return {
    status: "failed",
    message: "Multi-profile run failed",
    detail,
    error,
  };
}
