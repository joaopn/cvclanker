import { logger } from "@infra/logger";

/**
 * A GLOBAL retry budget for provider rate limits, shared by every LLM call in
 * the process rather than counted per call.
 *
 * A session/quota limit is account-wide and lasts hours, so per-call retries
 * just multiply the damage: each of N queued jobs burns its own retries and
 * then fails, and any caller that degrades gracefully on failure writes N
 * fabricated results. Once this budget is spent the process latches STOPPED,
 * and every subsequent call fails immediately without touching the provider —
 * which is what lets classification halt as a whole instead of job by job.
 *
 * The latch is cleared by `resetRateLimitBudget`, called when the user starts
 * new work (a pipeline run, a multi-profile chain, a manual rescore) — never
 * per job and never per profile, or a chain would simply re-hit the wall for
 * every remaining profile.
 */

interface BudgetState {
  remaining: number;
  stopped: boolean;
  reason: string | null;
  initialized: boolean;
}

const state: BudgetState = {
  remaining: 0,
  stopped: false,
  reason: null,
  initialized: false,
};

export function resetRateLimitBudget(retries: number): void {
  state.remaining = Math.max(0, retries);
  state.stopped = false;
  state.reason = null;
  state.initialized = true;
}

/**
 * Seed the budget from settings the first time any LLM call happens, so the
 * many entry points that aren't a pipeline run or a bulk action (CV upload,
 * tailoring, cover letters, ghostwriter, manual import…) get the configured
 * number of retries instead of the zero-value this module starts at. Without
 * it the very first rate limit anywhere would latch the whole process with no
 * retries at all, and only a pipeline run could clear it.
 */
export async function ensureRateLimitBudget(
  loadRetries: () => Promise<number>,
): Promise<void> {
  if (state.initialized) return;
  // Mark first: a concurrent second caller must not double-load, and a failure
  // below should fall back rather than re-throw into an unrelated LLM call.
  state.initialized = true;
  try {
    state.remaining = Math.max(0, await loadRetries());
  } catch {
    state.remaining = 0;
  }
}

/**
 * Spend one retry. Returns true when the caller should retry, false when the
 * budget is exhausted — at which point the process is latched stopped and the
 * message is kept for the user-facing error.
 */
export function consumeRateLimitRetry(reason: string): boolean {
  if (state.stopped) return false;
  if (state.remaining <= 0) {
    state.stopped = true;
    state.reason = reason;
    logger.error("LLM rate-limit retry budget exhausted, stopping LLM work", {
      reason,
    });
    return false;
  }
  state.remaining -= 1;
  logger.warn("LLM rate limited, spending a global retry", {
    reason,
    remaining: state.remaining,
  });
  return true;
}

export function isRateLimitStopped(): boolean {
  return state.stopped;
}

export function getRateLimitStopReason(): string | null {
  return state.reason;
}
