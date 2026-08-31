/**
 * Shared rate-limit pacing for startup.jobs.
 *
 * startup.jobs is Cloudflare-fronted and limits per IP, so the window belongs
 * to the PROCESS, not to one call: a chain runs its profiles back-to-back and
 * profile N+1 would otherwise start hammering an address profile N was just
 * refused on. Same reasoning as the LinkedIn guest pacer in
 * `orchestrator/src/server/services/live-status.ts`, whose 5s/60s schedule this
 * borrows rather than inventing a second one.
 *
 * What this can and cannot see, because it decides how much the pacing is
 * worth: the vendored `startup-jobs-scraper` swallows every per-hit detail-page
 * failure inside `enrichHit`, so the ONLY rate-limit signals that reach us are
 * the bootstrap GET, the Algolia query and the Algolia places lookup — the
 * first few requests of each term. The detail phase is ~95% of the traffic and
 * fails invisibly (logged as B64). So this module paces what it can observe and
 * the real rate lever is the `detail_concurrency` source-config field.
 *
 * No mutex here, unlike live-status. Not because there is only ever one caller
 * — a health probe can run `manifest.run` while a pipeline leg is mid-flight,
 * and the package fans out `detailConcurrency` detail fetches inside each call
 * — but because nothing in this module can interleave destructively:
 * `registerRateLimit` is await-free, and `waitForRateLimitWindow` re-reads
 * `nextAllowedAt` after every sleep rather than computing its wait once. That
 * re-read is the load-bearing part; hoisting it out of the loop reintroduces
 * the clobber live-status documents, where a turn already sleeping overwrites
 * a window another caller's 429 just opened.
 *
 * The exception is `waitedThisRunMs`, which is genuinely per-run state living
 * in a per-process module: a second caller's `beginRateLimitedRun()` zeroes a
 * live run's budget, which would hand back the unbounded wait that budget
 * exists to prevent, and its waits inflate the live run's counter. Unreachable
 * today — the only other caller is the health probe route, which nothing in
 * the client calls, and a chain runs one leg at a time — but a second
 * concurrent caller needs this moved into a per-run object, not another flag.
 */

/** Backoff schedule, borrowed wholesale from the LinkedIn guest pacer. */
const RATE_LIMIT_BACKOFF_BASE_MS = 5_000;
const RATE_LIMIT_BACKOFF_CAP_MS = 60_000;

/**
 * How often a wait wakes to re-check cancellation. A run is cancelled from the
 * UI and the user is watching a banner, so the wait has to be interruptible;
 * 250ms keeps that feeling immediate while costing nothing against waits
 * measured in seconds.
 */
const CANCEL_POLL_INTERVAL_MS = 250;

let baseBackoffMs = RATE_LIMIT_BACKOFF_BASE_MS;
let capBackoffMs = RATE_LIMIT_BACKOFF_CAP_MS;

/** Absolute epoch ms. Persists across runs on purpose — it self-expires. */
let nextAllowedAt = 0;
let currentBackoffMs = 0;
let waitedThisRunMs = 0;

/**
 * Total time one full escalation takes: 5s + 10s + 20s + 40s + 60s. Derived
 * from the schedule rather than picked, and used as the run's whole waiting
 * budget — see `hasExhaustedWaitBudget`.
 */
function escalationLadderMs(): number {
  // A zero base never reaches a positive cap — `nextBackoffMs(0)` returns the
  // base — and the loop is synchronous, so it would hang the event loop with
  // no test timeout to diagnose it. Zero anywhere means pacing is switched
  // off, which is what the test overrides use it for.
  if (baseBackoffMs <= 0 || capBackoffMs <= 0) return 0;
  let total = 0;
  let current = 0;
  for (;;) {
    const next = nextBackoffMs(current);
    total += next;
    if (next >= capBackoffMs) return total;
    current = next;
  }
}

/**
 * True once a run has spent more than one complete escalation inside backoff
 * windows.
 *
 * `MAX_RATE_LIMIT_ATTEMPTS` bounds the wait for ONE term, not for a run, and
 * the escalation only decays between runs — so a limit that flaps (each term
 * refused once, then served) never trips the stop rule and a leg with 84 terms
 * could sit in backoff for over an hour. Flapping is the pattern the
 * measurements actually show, not a corner case. Needing more than one full
 * ladder means this is not the short window the retry exists for, so the
 * source stops and the next run re-covers the same scrape window.
 *
 * It cannot tell "I was refused" from "a previous leg's window was still
 * open", so a leg starting inside an inherited 60s window spends part of its
 * budget before its own first refusal. That is the intended reading — the
 * machine really was being made to wait — but it does mean the later legs of a
 * chain get a smaller effective budget than the first.
 */
export function hasExhaustedWaitBudget(): boolean {
  return waitedThisRunMs > escalationLadderMs();
}

/**
 * The next window width for a given current one: opens at the base, doubles,
 * stops at the cap. Pure so the schedule is testable without sleeping.
 */
export function nextBackoffMs(current: number): number {
  if (current <= 0) return baseBackoffMs;
  return Math.min(capBackoffMs, current * 2);
}

/**
 * True when a failure means startup.jobs is refusing THIS MACHINE rather than
 * failing to read one posting.
 *
 * Two families, both per-IP and both meaning "stop and wait":
 * - An explicit 429 from the bootstrap/query/places requests.
 * - The connection-level refusals Cloudflare escalates to once an IP keeps
 *   pushing. Measured on the PI's prod: the same chain's error text moved from
 *   `bootstrap request failed: 429` to `error sending request` / `fetch failed`
 *   over a week. They are the same phenomenon, so they open the same window —
 *   but only the 429 family is worth RETRYING (see `isRetryableRateLimit`), as
 *   a genuine connectivity outage would retry into a wall.
 */
export function isRateLimited(message: string): boolean {
  return isRetryableRateLimit(message) || isConnectionRefusal(message);
}

/** A 429 proper: worth waiting out and retrying the same request. */
export function isRetryableRateLimit(message: string): boolean {
  return /\b429\b/.test(message) || /too many requests/i.test(message);
}

/**
 * The connection-level family: the half of `isRateLimited` that opens a window
 * without earning a retry. Exported to be tested directly — `run.ts` branches
 * on `isRetryableRateLimit` and never needs to name this one.
 */
export function isConnectionRefusal(message: string): boolean {
  return /network is unreachable|tcp connect error|error sending request|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|client error \(Connect\)|dns error/i.test(
    message,
  );
}

/** A refusal arrived: open the window, or double it if one is already open. */
export function registerRateLimit(): void {
  currentBackoffMs = nextBackoffMs(currentBackoffMs);
  nextAllowedAt = Date.now() + currentBackoffMs;
}

/**
 * Start-of-run reset. The ESCALATION is per run so a long-lived container
 * cannot creep to a permanent 60s penalty, but `nextAllowedAt` deliberately
 * survives: a window another leg opened seconds ago is still open, and being an
 * absolute timestamp it costs a later run nothing once it has passed.
 */
export function beginRateLimitedRun(): void {
  currentBackoffMs = 0;
  waitedThisRunMs = 0;
}

/** Milliseconds still to wait, 0 when the window is clear. */
export function remainingWindowMs(): number {
  return Math.max(0, nextAllowedAt - Date.now());
}

/**
 * Wait out any open window, waking every `CANCEL_POLL_INTERVAL_MS` so a
 * cancelled run does not sit through a 60s penalty before noticing.
 *
 * Re-reads `nextAllowedAt` each pass rather than computing the wait once: the
 * window can be extended while this call is already sleeping.
 *
 * @returns false when the wait was abandoned because the run was cancelled.
 */
export async function waitForRateLimitWindow(
  shouldCancel?: () => boolean,
): Promise<boolean> {
  for (;;) {
    if (shouldCancel?.()) return false;
    const remaining = remainingWindowMs();
    if (remaining === 0) return true;
    const slice = Math.min(remaining, CANCEL_POLL_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, slice));
    waitedThisRunMs += slice;
  }
}

/**
 * Test-only: clear the shared window and, optionally, shrink the schedule so a
 * test can exercise the retry path without real sleeping. Overriding the
 * constants beats fake timers here — the sleep is awaited inside the call under
 * test, so a fake clock has no one to advance it and the test deadlocks.
 */
export function resetRateLimitStateForTests(overrides?: {
  baseMs?: number;
  capMs?: number;
}): void {
  nextAllowedAt = 0;
  currentBackoffMs = 0;
  waitedThisRunMs = 0;
  baseBackoffMs = overrides?.baseMs ?? RATE_LIMIT_BACKOFF_BASE_MS;
  capBackoffMs = overrides?.capMs ?? RATE_LIMIT_BACKOFF_CAP_MS;
}
