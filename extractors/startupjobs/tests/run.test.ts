import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerRateLimit,
  remainingWindowMs,
  resetRateLimitStateForTests,
} from "../src/rate-limit";

vi.mock("startup-jobs-scraper", () => ({
  scrapeStartupJobsViaAlgolia: vi.fn(),
}));

/** Minimal record shaped like what the scraper returns; only jobUrl is load-bearing. */
function record(id: string) {
  return {
    title: `Engineer ${id}`,
    employer: "Acme",
    jobUrl: `https://startup.jobs/${id}`,
    jobDescription: "description",
  };
}

function rateLimit() {
  return new Error("startup.jobs bootstrap request failed: 429");
}

describe("runStartupJobs", () => {
  beforeEach(() => {
    // resetAllMocks, NOT clearAllMocks: the rate-limit tests below install
    // persistent `mockImplementation`s, and clearAllMocks wipes recorded calls
    // while leaving the implementation in place — it would leak into the next
    // test. (It also clears any unconsumed `*Once` queue, which clearAllMocks
    // would leave behind; the tests above happen not to leave one.)
    vi.resetAllMocks();
    // Module state is shared across tests in this file. baseMs/capMs of 0 keep
    // the retry path exercised without sleeping through a real backoff, and an
    // absolute window left open by one test would otherwise stall the next.
    resetRateLimitStateForTests({ baseMs: 0, capMs: 0 });
  });

  it("falls back to the default max jobs per term when options.maxJobsPerTerm is NaN", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    scrapeMock.mockResolvedValueOnce([]);

    const { runStartupJobs } = await import("../src/run");

    await runStartupJobs({
      searchTerms: ["backend engineer"],
      locations: ["UK"],
      maxJobsPerTerm: Number.NaN,
    });

    expect(scrapeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedCount: 50,
      }),
    );
  });

  it("skips the scrape (no jobs, no error) when no concrete location resolves", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);

    const { runStartupJobs } = await import("../src/run");

    const result = await runStartupJobs({
      searchTerms: ["platform engineer"],
      selectedCountry: "worldwide",
      locations: ["Worldwide"],
    });

    expect(scrapeMock).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("normalizes explicit city-country aliases before passing location to the scraper", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    scrapeMock.mockResolvedValueOnce([]);

    const { runStartupJobs } = await import("../src/run");

    await runStartupJobs({
      searchTerms: ["software engineer"],
      locations: ["UK"],
    });

    expect(scrapeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        location: "United Kingdom",
      }),
    );
  });

  it("passes workplaceType to the scraper", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    scrapeMock.mockResolvedValueOnce([]);

    const { runStartupJobs } = await import("../src/run");

    await runStartupJobs({
      searchTerms: ["software engineer"],
      locations: ["UK"],
      workplaceTypes: ["remote", "hybrid"],
    });

    expect(scrapeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workplaceType: ["remote", "hybrid"],
      }),
    );
  });

  it("maps onsite workplaceType to the scraper's on-site value", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    scrapeMock.mockResolvedValueOnce([]);

    const { runStartupJobs } = await import("../src/run");

    await runStartupJobs({
      searchTerms: ["software engineer"],
      locations: ["UK"],
      workplaceTypes: ["onsite"],
    });

    expect(scrapeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workplaceType: ["on-site"],
      }),
    );
  });

  it("passes detailConcurrency through to the scraper", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    scrapeMock.mockResolvedValueOnce([]);

    const { runStartupJobs } = await import("../src/run");

    await runStartupJobs({
      searchTerms: ["software engineer"],
      locations: ["UK"],
      detailConcurrency: 1,
    });

    expect(scrapeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        detailConcurrency: 1,
      }),
    );
  });

  it("retries the same term through the backoff after a 429 and keeps going", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    let calls = 0;
    scrapeMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw rateLimit();
      return [record(String(calls))];
    });

    const { runStartupJobs } = await import("../src/run");

    const result = await runStartupJobs({
      searchTerms: ["a", "b"],
      locations: ["UK"],
    });

    // Two terms, the first of which needed a second attempt.
    expect(calls).toBe(3);
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(2);
  });

  it("salvages the jobs already scraped when a later term is rate limited", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    let term = 0;
    scrapeMock.mockImplementation(async () => {
      term += 1;
      if (term <= 2) return [record(`t${term}-a`), record(`t${term}-b`)];
      throw rateLimit();
    });

    const { runStartupJobs } = await import("../src/run");

    const result = await runStartupJobs({
      searchTerms: ["a", "b", "c"],
      locations: ["UK"],
    });

    // The whole point: failure, but the four jobs from terms 1-2 survive.
    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(4);
    expect(result.error).toMatch(/rate limiting this machine/i);
    expect(result.error).toMatch(/jobs already scraped were kept/i);
  });

  it("stops the whole source on a sustained refusal, including later cities", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    scrapeMock.mockRejectedValue(rateLimit());

    const { runStartupJobs } = await import("../src/run");

    const result = await runStartupJobs({
      searchTerms: ["a", "b"],
      locations: ["London", "Manchester"],
    });

    // Three attempts on the first term, then stop -- NOT 3 per term, and in
    // particular the second city is never reached (an inner-loop-only break
    // would carry on to it and re-prove the same per-IP refusal).
    expect(scrapeMock).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
    expect(result.jobs).toEqual([]);
  });

  it("does not retry a connection-level refusal, but still salvages", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    let term = 0;
    scrapeMock.mockImplementation(async () => {
      term += 1;
      if (term === 1) return [record("kept")];
      throw new Error("error sending request for url (https://startup.jobs/)");
    });

    const { runStartupJobs } = await import("../src/run");

    const result = await runStartupJobs({
      searchTerms: ["a", "b", "c"],
      locations: ["UK"],
    });

    // One good term, then a single failed attempt -- no retries.
    expect(term).toBe(2);
    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(1);
    expect(result.error).toMatch(/refusing connections/i);
  });

  it("salvages when a term fails for a reason that is not a rate limit", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    let term = 0;
    scrapeMock.mockImplementation(async () => {
      term += 1;
      if (term === 1) return [record("kept")];
      throw new Error("Missing Algolia config fields: {}");
    });

    const { runStartupJobs } = await import("../src/run");

    const result = await runStartupJobs({
      searchTerms: ["a", "b"],
      locations: ["UK"],
    });

    // Reaches the outer catch (no retry), which must salvage too.
    expect(term).toBe(2);
    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(1);
    expect(result.error).toMatch(/Missing Algolia config/);
  });
  // The tests above run with a zero-width window so the retry logic is fast to
  // exercise. These ones use a REAL (small) window, because with baseMs 0 every
  // wait is a no-op and deleting the pacing call sites entirely leaves the rest
  // of this file green.

  it("waits out the shared window and opens one on a 429", async () => {
    resetRateLimitStateForTests({ baseMs: 300, capMs: 300 });
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    let calls = 0;
    vi.mocked(scrapeStartupJobsViaAlgolia).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw rateLimit();
      return [record("1")];
    });

    const { runStartupJobs } = await import("../src/run");
    const startedAt = Date.now();
    const result = await runStartupJobs({
      searchTerms: ["a"],
      locations: ["UK"],
    });

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    // Deleting either registerRateLimit() or waitForRateLimitWindow() from the
    // call site drops this to ~0ms — which is what makes the wiring, and not
    // just the module, tested.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
  });

  it("starts each run at the base backoff instead of continuing the last one's escalation", async () => {
    resetRateLimitStateForTests({ baseMs: 50, capMs: 60_000 });
    // Stand in for a previous chain leg that escalated to 200ms.
    registerRateLimit();
    registerRateLimit();
    registerRateLimit();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    vi.mocked(scrapeStartupJobsViaAlgolia).mockRejectedValue(rateLimit());

    const { runStartupJobs } = await import("../src/run");
    await runStartupJobs({ searchTerms: ["a"], locations: ["UK"] });

    // Three refusals from a fresh ladder end at 200ms. Without
    // beginRateLimitedRun() they would continue 400/800/1600 and end at 1600.
    expect(remainingWindowMs()).toBeLessThanOrEqual(300);
  });

  it("abandons an open window when the run is cancelled, keeping what it scraped", async () => {
    resetRateLimitStateForTests({ baseMs: 5_000, capMs: 5_000 });
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    let cancelled = false;
    let calls = 0;
    vi.mocked(scrapeStartupJobsViaAlgolia).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return [record("kept")];
      // Refused, and the user hits Cancel while the 5s window is open.
      cancelled = true;
      throw rateLimit();
    });

    const { runStartupJobs } = await import("../src/run");
    const startedAt = Date.now();
    const result = await runStartupJobs({
      searchTerms: ["a", "b"],
      locations: ["UK"],
      shouldCancel: () => cancelled,
    });

    // Cancellation is reported as success with the partial haul, matching the
    // pre-existing cancel path at the top of the term loop.
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    // Did not sit through the full 5s window before noticing.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("stops the source once a flapping limit has burned the run's whole wait budget", async () => {
    // base === cap === 50 makes the escalation ladder 50ms, so the budget is
    // spent after two waits.
    resetRateLimitStateForTests({ baseMs: 50, capMs: 50 });
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    let calls = 0;
    vi.mocked(scrapeStartupJobsViaAlgolia).mockImplementation(async () => {
      calls += 1;
      // Flapping: every term is refused once and served on the retry, so the
      // per-term attempt limit is never reached and only the run-level budget
      // can stop this.
      if (calls % 2 === 1) throw rateLimit();
      return [record(String(calls))];
    });

    const { runStartupJobs } = await import("../src/run");
    const result = await runStartupJobs({
      searchTerms: ["a", "b", "c", "d", "e", "f"],
      locations: ["UK"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/kept rate limiting this machine/i);
    // Inequalities, not exact counts: in the flapping pattern the accumulated
    // wait tracks the ladder exactly, so `waited === ladder` is a boundary the
    // timer can land either side of (measured ~1% of runs accrue one extra
    // millisecond and stop a term earlier). What matters is that it stopped at
    // all -- without the budget check all six terms are served, which is 12
    // calls and a successful run.
    expect(calls).toBeLessThan(12);
    expect(result.jobs.length).toBeGreaterThan(0);
    expect(result.jobs.length).toBeLessThan(6);
  });

  it("counts only the terms that completed, and claims kept jobs only when there are some", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    vi.mocked(scrapeStartupJobsViaAlgolia).mockRejectedValue(rateLimit());

    const { runStartupJobs } = await import("../src/run");
    const result = await runStartupJobs({
      searchTerms: ["a", "b"],
      locations: ["UK"],
    });

    // The first term FAILED, so zero completed -- reporting "1 of 2" would
    // claim coverage the run never had.
    expect(result.error).toMatch(/stopped after 0 of 2 term searches\./);
    expect(result.error).not.toMatch(/already scraped/);
    // No detailConcurrency passed, so this exercises the `?? 1` fallback: at
    // the floor there is nothing left to lower, and the message must not tell
    // the user to lower it.
    expect(result.error).not.toMatch(/Lower "Detail concurrency"/);
    expect(result.error).toMatch(/already at its floor of 1/);
  });

  it("names the kept jobs and offers the concurrency lever when one exists", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    let calls = 0;
    vi.mocked(scrapeStartupJobsViaAlgolia).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return [record("kept")];
      throw rateLimit();
    });

    const { runStartupJobs } = await import("../src/run");
    const result = await runStartupJobs({
      searchTerms: ["a", "b"],
      locations: ["UK"],
      detailConcurrency: 4,
    });

    expect(result.error).toMatch(
      /stopped after 1 of 2 term searches; the 1 job already scraped was kept\./,
    );
    expect(result.error).toMatch(/Lower "Detail concurrency"/);
  });

  it("reports a scraper that returns nothing as a failure, not an empty scrape", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    const scrapeMock = vi.mocked(scrapeStartupJobsViaAlgolia);
    scrapeMock.mockResolvedValueOnce([record("kept")]);
    // What a reset-but-unstubbed mock resolves to, and the only way the
    // defensive guard after the retry loop can actually fire.
    scrapeMock.mockResolvedValueOnce(undefined as never);

    const { runStartupJobs } = await import("../src/run");
    const result = await runStartupJobs({
      searchTerms: ["a", "b"],
      locations: ["UK"],
    });

    // Must not be reported as "term 2 found no jobs".
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/returned no result for term 2 of 2/);
    expect(result.error).toMatch(/the 1 job already scraped was kept/);
    expect(result.jobs).toHaveLength(1);
  });

  it("offers a lever on the connection-refusal message too", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    vi.mocked(scrapeStartupJobsViaAlgolia).mockRejectedValue(
      new Error("error sending request for url (https://startup.jobs/)"),
    );

    const { runStartupJobs } = await import("../src/run");

    // This is the branch a sustained refusal actually reaches -- prod's errors
    // escalated from 429 to this shape over a week -- so it must not be the one
    // that tells the user nothing about what to do.
    const floor = await runStartupJobs({
      searchTerms: ["a"],
      locations: ["UK"],
    });
    expect(floor.error).toMatch(/refusing connections/i);
    expect(floor.error).toMatch(/already at its floor of 1/);

    const raised = await runStartupJobs({
      searchTerms: ["a"],
      locations: ["UK"],
      detailConcurrency: 4,
    });
    expect(raised.error).toMatch(/Lower "Detail concurrency"/);
  });

  it("never explains the cause on a branch that cannot know it", async () => {
    const { scrapeStartupJobsViaAlgolia } = await import(
      "startup-jobs-scraper"
    );
    vi.mocked(scrapeStartupJobsViaAlgolia).mockRejectedValue(
      new Error("fetch failed"),
    );

    const { runStartupJobs } = await import("../src/run");
    const result = await runStartupJobs({
      searchTerms: ["a"],
      locations: ["UK"],
    });

    // The message says a connectivity problem is indistinguishable from a rate
    // limit, so the advice must not then assert the run was too large. The
    // negative is a tripwire for the specific wording that was removed here,
    // not a general guard — it cannot catch a differently-phrased claim.
    expect(result.error).toMatch(/looks identical from here/);
    expect(result.error).not.toMatch(/larger than the site/);
  });
});
