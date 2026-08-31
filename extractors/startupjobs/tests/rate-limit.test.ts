import { beforeEach, describe, expect, it } from "vitest";

import {
  beginRateLimitedRun,
  hasExhaustedWaitBudget,
  isConnectionRefusal,
  isRateLimited,
  isRetryableRateLimit,
  nextBackoffMs,
  registerRateLimit,
  remainingWindowMs,
  resetRateLimitStateForTests,
  waitForRateLimitWindow,
} from "../src/rate-limit";

describe("startup.jobs rate-limit pacing", () => {
  beforeEach(() => {
    resetRateLimitStateForTests();
  });

  describe("refusal classification", () => {
    // The three throw sites in startup-jobs-scraper that can actually reach
    // us. The fourth ("Job detail request failed") is swallowed per hit by the
    // package's own enrichHit, so it is deliberately NOT asserted here — a
    // test claiming we handle it would be describing a path that cannot run
    // (logged as B64).
    it.each([
      "startup.jobs bootstrap request failed: 429",
      "Algolia query failed: 429",
      "Algolia places query failed: 429",
      "Too Many Requests",
    ])("treats %s as a retryable rate limit", (message) => {
      expect(isRetryableRateLimit(message)).toBe(true);
      expect(isRateLimited(message)).toBe(true);
    });

    it.each([
      "error sending request for url (https://startup.jobs/)",
      "fetch failed",
      "client error (Connect): dns error",
      "ECONNRESET",
    ])("treats %s as a connection refusal, not retryable", (message) => {
      expect(isConnectionRefusal(message)).toBe(true);
      // Opens a window (it is the same per-IP phenomenon escalating) but must
      // not be retried — retrying a genuine outage waits into a wall.
      expect(isRateLimited(message)).toBe(true);
      expect(isRetryableRateLimit(message)).toBe(false);
    });

    it.each([
      "startup.jobs bootstrap request failed: 503",
      "Missing Algolia config fields: {}",
      "Executable doesn't exist, please install",
    ])("leaves %s to the caller as a real fault", (message) => {
      expect(isRateLimited(message)).toBe(false);
    });

    it("does not read a 429 out of an unrelated number", () => {
      // \b429\b, not /429/ — a job id or byte count must not latch the pacer.
      expect(isRetryableRateLimit("scraped 14290 items")).toBe(false);
      expect(isRetryableRateLimit("request 1429 failed")).toBe(false);
    });
  });

  describe("backoff schedule", () => {
    it("opens at 5s, doubles, and stops at the 60s cap", () => {
      // Pure, so the whole schedule is asserted without sleeping through it.
      const schedule: number[] = [];
      let current = 0;
      for (let i = 0; i < 6; i += 1) {
        current = nextBackoffMs(current);
        schedule.push(current);
      }
      expect(schedule).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    });

    it("opens a window that later doublings extend", () => {
      registerRateLimit();
      const first = remainingWindowMs();
      expect(first).toBeGreaterThan(4_000);
      expect(first).toBeLessThanOrEqual(5_000);

      registerRateLimit();
      expect(remainingWindowMs()).toBeGreaterThan(9_000);
    });
  });

  describe("cross-run state", () => {
    it("resets the escalation per run but keeps an open window", () => {
      registerRateLimit();
      registerRateLimit();
      registerRateLimit();
      const inherited = remainingWindowMs();
      expect(inherited).toBeGreaterThan(19_000);

      beginRateLimitedRun();

      // The window a previous leg opened still applies — it is an absolute
      // deadline, and the machine is still inside it.
      expect(remainingWindowMs()).toBeGreaterThan(19_000);
      // But the next refusal starts the schedule over rather than continuing
      // toward a permanent 60s penalty on a long-lived container.
      registerRateLimit();
      expect(remainingWindowMs()).toBeLessThanOrEqual(5_000);
    });
  });

  describe("wait budget", () => {
    it("terminates for a zero base backoff", () => {
      // Regression: escalationLadderMs walked `next = nextBackoffMs(0)` toward
      // a positive cap it could never reach, spinning synchronously. That hangs
      // the event loop, so vitest's own timeout cannot fire and the fork dies
      // with no diagnostic -- and {baseMs: 0} is the natural "pacing off"
      // idiom a test would reach for.
      resetRateLimitStateForTests({ baseMs: 0 });
      expect(hasExhaustedWaitBudget()).toBe(false);

      resetRateLimitStateForTests({ baseMs: 0, capMs: 0 });
      expect(hasExhaustedWaitBudget()).toBe(false);
    });

    it("is not exhausted by a run that never waits", async () => {
      resetRateLimitStateForTests();
      await waitForRateLimitWindow();
      expect(hasExhaustedWaitBudget()).toBe(false);
    });

    it("trips once a run has waited more than one full escalation", async () => {
      // Ladder is 60 + 120 = 180ms, and each checkpoint sits a whole window
      // clear of it: one wait totals 60 (120 under), three total 300 (120
      // over). Asserting AT the tie is what made the earlier budget test flake
      // — the wait loop adds a second 1ms slice when setTimeout fires just
      // before Date.now() reaches the deadline.
      resetRateLimitStateForTests({ baseMs: 60, capMs: 120 });
      expect(hasExhaustedWaitBudget()).toBe(false);

      registerRateLimit();
      await waitForRateLimitWindow();
      expect(hasExhaustedWaitBudget()).toBe(false);

      for (let i = 0; i < 2; i += 1) {
        registerRateLimit();
        await waitForRateLimitWindow();
      }
      expect(hasExhaustedWaitBudget()).toBe(true);

      // A new run gets a fresh budget, even though the window it inherits does
      // not reset.
      beginRateLimitedRun();
      expect(hasExhaustedWaitBudget()).toBe(false);
    });
  });

  describe("waiting", () => {
    it("returns immediately when no window is open", async () => {
      const startedAt = Date.now();
      await expect(waitForRateLimitWindow()).resolves.toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(100);
    });

    it("waits out an open window", async () => {
      resetRateLimitStateForTests({ baseMs: 300, capMs: 300 });
      registerRateLimit();

      const startedAt = Date.now();
      await expect(waitForRateLimitWindow()).resolves.toBe(true);
      const waited = Date.now() - startedAt;

      expect(waited).toBeGreaterThanOrEqual(250);
      expect(remainingWindowMs()).toBe(0);
    });

    it("abandons the wait when the run is cancelled", async () => {
      // A latched 60s window must not make Cancel unreachable: the wait wakes
      // to re-check rather than sleeping the whole window in one go.
      registerRateLimit();

      const startedAt = Date.now();
      await expect(waitForRateLimitWindow(() => true)).resolves.toBe(false);

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      // The window is untouched — cancelling a run does not clear the machine's
      // penalty for the next one.
      expect(remainingWindowMs()).toBeGreaterThan(1_000);
    });

    it("notices a cancellation raised while it is already sleeping", async () => {
      resetRateLimitStateForTests({ baseMs: 5_000, capMs: 5_000 });
      registerRateLimit();

      let cancelled = false;
      setTimeout(() => {
        cancelled = true;
      }, 300);

      const startedAt = Date.now();
      await expect(waitForRateLimitWindow(() => cancelled)).resolves.toBe(
        false,
      );

      // Woke up mid-window rather than sleeping the full 5s.
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
  });
});
