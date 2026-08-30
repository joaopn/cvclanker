import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import {
  fetchLinkedinLiveStatus,
  isLinkedinBlockedError,
} from "@server/services/live-status";
import { getEffectiveSettings } from "@server/services/settings";
import { progressHelpers } from "../progress";

export interface RefreshLiveStatusResult {
  /** Rows whose live status was read and written. */
  checked: number;
  /**
   * Rows this run did not manage to store a verdict for — the check failed, or
   * the row was deleted under the write. Nothing was written either way.
   */
  failed: number;
  /** Rows found no longer accepting applications (a subset of `checked`). */
  closed: number;
  /** Rows the step picked but never reached — cancelled, or LinkedIn blocked. */
  unchecked: number;
}

/**
 * Re-read the live LinkedIn status of rows already in the database, so the
 * open/closed verdict and the applicant caption are current without anyone
 * hand-selecting rows in Manage.
 *
 * SEQUENTIAL on purpose: `live-status.ts` serializes every LinkedIn request
 * behind one process-wide pacer at 1s spacing, both fetch tiers and all
 * callers, so a pool would buy nothing but overlapped HTML parsing while
 * making the cancellation check racy. A row costs a second or two when
 * LinkedIn answers and up to `manualJobFetchTimeoutMs` plus the settle wait
 * when it has to fall through to the browser tier, so the cap is a wide time
 * budget and the stop-on-blocked below is what really bounds a bad run.
 *
 * `liveStatusRefreshMinAgeHours` is what keeps a run off rows it read an hour
 * ago — but only where the cap was not already doing it by accident. Without a
 * floor, checked rows are stamped and move to the tail, so consecutive runs
 * take consecutive slices; that rotation holds ONLY while the eligible backlog
 * is larger than the cap. Once it is smaller, or the cap is raised, every run
 * reaches the fresh end and re-reads it, and each leg of a chain re-reads what
 * the leg before it just stamped.
 *
 * BEST-EFFORT, and that is enforced rather than asserted: the whole body is
 * wrapped, so nothing here — not a failed settings read, not a failed query —
 * can fail the run. This refreshes ancillary data; a run that scraped,
 * imported and scored correctly must not be reported as failed because
 * LinkedIn would not answer.
 *
 * It DOES stop early when LinkedIn refuses the machine (a 429 backoff, or the
 * sign-in wall). Those are per-IP and shared by every caller, so continuing
 * down the list cannot succeed and only adds heat — the same reasoning as the
 * global LLM rate-limit latch. A queue-pressure refusal (the shared pacer busy
 * with a concurrent manual bulk check) is deliberately NOT that signal — one
 * impatient caller must not be able to stop an unrelated sweep, and starvation
 * can be transient, with the next row succeeding. The accepted cost is real
 * though: a slot is chained onto the shared queue, so a starved row waits its
 * whole fetch budget before refusing, and a sweep contended for its full
 * duration can spend that budget per row and store nothing. Bounded by the
 * cap, corrupts nothing, and the next run finds the same queue — but it is
 * time, not milliseconds.
 *
 * The cap is read here while the on/off decision is resolved by the caller.
 * Deliberate: the flag is a per-run choice the Run menu offers, the cap is an
 * operator setting with no per-run surface, so each is resolved where it is
 * decided.
 *
 * Cancellation is checked between rows, so a cancel lands up to one row late
 * (the fetch timeout plus the settle wait). That is the same granularity every
 * other step has, and finer than scoring's, where one LLM call can hold it for
 * `llmRequestTimeoutMs`.
 */
export async function refreshLiveStatusStep(args: {
  shouldCancel?: () => boolean;
}): Promise<RefreshLiveStatusResult> {
  let total = 0;
  let checked = 0;
  let failed = 0;
  let closed = 0;
  let index = 0;

  try {
    const settings = await getEffectiveSettings();
    const limit = settings.liveStatusRefreshLimit.value;
    const minAgeHours = settings.liveStatusRefreshMinAgeHours.value;
    const candidates = await jobsRepo.getJobsForLiveStatusRefresh(
      limit,
      minAgeHours,
    );
    total = candidates.length;

    if (total === 0) {
      logger.info("Live-status refresh found nothing to check", {
        limit,
        minAgeHours,
      });
      return { checked: 0, failed: 0, closed: 0, unchecked: 0 };
    }

    logger.info("Running live-status refresh step", {
      candidates: total,
      limit,
      minAgeHours,
    });

    for (const candidate of candidates) {
      if (args.shouldCancel?.()) break;
      index += 1;
      progressHelpers.liveStatusJob(index, total, candidate.title);

      try {
        const status = await fetchLinkedinLiveStatus(
          candidate.jobUrl,
          candidate.sourceJobId,
        );
        // The same three columns the manual `fetch_live_status` action writes,
        // including the rule that a closed posting stores a NULL applicant
        // count (LinkedIn resets the caption on closure, so the number would
        // be fabricated).
        const updated = await jobsRepo.updateJob(candidate.id, {
          liveClosed: status.closed,
          liveApplicants: status.applicants,
          liveStatusCheckedAt: new Date().toISOString(),
        });
        if (!updated) {
          // The row went away between the query and the write. Nothing was
          // stored, so counting it as checked would overstate what this run
          // actually refreshed.
          failed += 1;
          continue;
        }
        checked += 1;
        if (status.closed) closed += 1;
      } catch (error) {
        failed += 1;
        if (isLinkedinBlockedError(error)) {
          logger.warn(
            "Stopping the live-status refresh: LinkedIn is refusing requests from this machine",
            {
              jobId: candidate.id,
              checked,
              remaining: total - index,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          break;
        }
        logger.warn("Live-status check failed for one job", {
          jobId: candidate.id,
          title: candidate.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    // Reached only by a failure OUTSIDE one posting's check — the settings
    // read, the query, or a progress emit. Swallowed for the same reason the
    // per-posting failures are: this step refreshes ancillary data and must
    // never be the thing that fails a run.
    logger.warn("Live-status refresh step aborted", {
      checked,
      failed,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Derived from the counters, NOT from the loop index: `index` is bumped
  // before the row is attempted, so a row abandoned mid-flight (the outer
  // catch) is counted as reached while contributing to neither counter, and
  // `total - index` would then lose it. checked + failed + unchecked === total
  // on every path.
  const unchecked = Math.max(0, total - checked - failed);
  logger.info("Live-status refresh step completed", {
    checked,
    failed,
    closed,
    unchecked,
  });

  return { checked, failed, closed, unchecked };
}
