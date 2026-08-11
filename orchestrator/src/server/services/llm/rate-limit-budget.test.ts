// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeRateLimitRetry,
  getRateLimitStopReason,
  isRateLimitStopped,
  resetRateLimitBudget,
} from "./rate-limit-budget";

beforeEach(() => {
  resetRateLimitBudget(0);
});

describe("rate-limit budget", () => {
  it("spends retries then latches stopped", () => {
    resetRateLimitBudget(2);

    expect(consumeRateLimitRetry("limit")).toBe(true);
    expect(consumeRateLimitRetry("limit")).toBe(true);
    expect(isRateLimitStopped()).toBe(false);

    // Third ask exhausts it.
    expect(consumeRateLimitRetry("session limit reached")).toBe(false);
    expect(isRateLimitStopped()).toBe(true);
    expect(getRateLimitStopReason()).toBe("session limit reached");
  });

  it("counts globally, not per caller", () => {
    resetRateLimitBudget(1);

    // Two different callers sharing one budget: the first spends it, the
    // second finds nothing left. This is the whole point — a per-call budget
    // would let every queued job retry independently.
    expect(consumeRateLimitRetry("caller A")).toBe(true);
    expect(consumeRateLimitRetry("caller B")).toBe(false);
    expect(isRateLimitStopped()).toBe(true);
  });

  it("stops at the first rate limit when configured to zero", () => {
    resetRateLimitBudget(0);

    expect(consumeRateLimitRetry("limit")).toBe(false);
    expect(isRateLimitStopped()).toBe(true);
  });

  it("stays stopped until a reset", () => {
    resetRateLimitBudget(0);
    consumeRateLimitRetry("limit");
    expect(isRateLimitStopped()).toBe(true);

    // Asking again must not quietly un-stop it.
    expect(consumeRateLimitRetry("limit")).toBe(false);
    expect(isRateLimitStopped()).toBe(true);

    resetRateLimitBudget(3);
    expect(isRateLimitStopped()).toBe(false);
    expect(getRateLimitStopReason()).toBeNull();
  });

  it("treats a negative budget as zero", () => {
    resetRateLimitBudget(-5);
    expect(consumeRateLimitRetry("limit")).toBe(false);
    expect(isRateLimitStopped()).toBe(true);
  });
});

// Its own describe with a fresh module instance: the seeding path only runs
// while the module has never been initialised, and the beforeEach above
// (correctly) marks it initialised.
describe("first-use seeding", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("seeds from settings on first use, so non-route callers get retries", async () => {
    // Without this, a CV upload or a tailor hitting the first 429 would latch
    // the whole process with zero retries, and only a pipeline run could clear
    // it — the module starts at 0.
    const budget = await import("./rate-limit-budget");
    const load = vi.fn().mockResolvedValue(4);

    await budget.ensureRateLimitBudget(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(budget.consumeRateLimitRetry("limit")).toBe(true);

    // Second call must not re-load or re-seed.
    await budget.ensureRateLimitBudget(load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("falls back to zero when the settings read fails, without throwing", async () => {
    const budget = await import("./rate-limit-budget");

    await budget.ensureRateLimitBudget(async () => {
      throw new Error("db down");
    });
    expect(budget.consumeRateLimitRetry("limit")).toBe(false);
  });

  it("does not re-seed after an explicit reset", async () => {
    const budget = await import("./rate-limit-budget");
    budget.resetRateLimitBudget(1);
    const load = vi.fn().mockResolvedValue(99);

    await budget.ensureRateLimitBudget(load);

    expect(load).not.toHaveBeenCalled();
    expect(budget.consumeRateLimitRetry("limit")).toBe(true);
    expect(budget.consumeRateLimitRetry("limit")).toBe(false);
  });
});
