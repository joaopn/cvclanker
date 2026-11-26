// @vitest-environment node
import { createJob } from "@shared/testing/factories";
import type { Job } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateJob = vi.fn();
const getJobById = vi.fn();
const fetchJobDraft = vi.fn();
const scoreJobSuitability = vi.fn();
const isRateLimitStopped = vi.fn();
const updateProgress = vi.fn();

vi.mock("@server/repositories/jobs", () => ({
  updateJob: (...args: unknown[]) => updateJob(...args),
  getJobById: (...args: unknown[]) => getJobById(...args),
}));
vi.mock("@server/services/llm/rate-limit-budget", () => ({
  isRateLimitStopped: () => isRateLimitStopped(),
  getRateLimitStopReason: () => "limit reached",
}));
vi.mock("@server/repositories/settings", () => ({
  getSetting: vi.fn(),
}));
vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: async () => ({ bulkActionConcurrency: { value: 1 } }),
}));
vi.mock("@server/services/manualJob", () => ({
  fetchJobDraft: (...args: unknown[]) => fetchJobDraft(...args),
}));
vi.mock("@server/services/scorer", () => ({
  JobNotScoreableError: class extends Error {},
  JobScoringFailedError: class extends Error {},
  LlmRateLimitStopError: class extends Error {},
  MIN_SCOREABLE_DESCRIPTION_CHARS: 100,
  scoreJobSuitability: (...args: unknown[]) => scoreJobSuitability(...args),
}));
vi.mock("../progress", () => ({
  updateProgress: (...args: unknown[]) => updateProgress(...args),
  progressHelpers: { scoringJob: vi.fn(), scoringComplete: vi.fn() },
}));

import { LlmRateLimitStopError } from "@server/services/scorer";
import { rescrapeUnscoreableStep } from "./rescrape-unscoreable";

const FETCHED =
  "Example Corp is hiring a platform engineer to run its build and deploy tooling across several teams, remote within the EU.";

const shortJob = (overrides: Partial<Job> = {}) =>
  createJob({
    id: "job-1",
    title: "Platform Engineer",
    status: "discovered",
    jobUrl: "https://jobs.example.com/view/1",
    jobDescription: "Too short.",
    suitabilityCategory: null,
    appliedAt: null,
    ...overrides,
  });

describe("rescrapeUnscoreableStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset, not just clear: a queued once-value left unconsumed by one test
    // would otherwise answer the next test's first fetch.
    updateJob.mockReset();
    getJobById.mockReset();
    fetchJobDraft.mockReset();
    scoreJobSuitability.mockReset();
    isRateLimitStopped.mockReset();
    isRateLimitStopped.mockReturnValue(false);
    getJobById.mockImplementation(async (id: string) => shortJob({ id }));
    updateJob.mockImplementation(
      async (id: string, patch: Record<string, unknown>) => ({
        ...shortJob({ id }),
        ...patch,
      }),
    );
    fetchJobDraft.mockResolvedValue({
      job: { jobDescription: FETCHED },
      usage: null,
      warning: null,
    });
    scoreJobSuitability.mockResolvedValue({
      category: "bad_fit",
      reason: "no",
      model: "m",
      effort: null,
    });
  });

  it("saves the fetched description, scores the job from it and applies the run's auto-skip tier", async () => {
    const scored = await rescrapeUnscoreableStep({
      jobs: [shortJob()],
      brief: "brief",
      autoSkipCategory: "bad_fit",
    });

    expect(updateJob.mock.calls[0][0]).toBe("job-1");
    expect(updateJob.mock.calls[0][1].jobDescription).toBe(FETCHED);
    expect(scoreJobSuitability.mock.calls[0][0].jobDescription).toBe(FETCHED);
    expect(updateJob.mock.calls[1][1].suitabilityCategory).toBe("bad_fit");
    expect(updateJob.mock.calls[1][1].status).toBe("skipped");
    expect(scored.map((job) => job.id)).toEqual(["job-1"]);
  });

  it("leaves a job whose fetch fails untouched and carries on with the next", async () => {
    fetchJobDraft
      .mockRejectedValueOnce(new Error("page gone"))
      .mockResolvedValueOnce({
        job: { jobDescription: FETCHED },
        usage: null,
        warning: null,
      });

    const scored = await rescrapeUnscoreableStep({
      jobs: [shortJob({ id: "job-1" }), shortJob({ id: "job-2" })],
      brief: "brief",
      autoSkipCategory: null,
    });

    expect(updateJob.mock.calls.map((call) => call[0])).not.toContain("job-1");
    expect(scored.map((job) => job.id)).toEqual(["job-2"]);
  });

  it.each([
    ["no", "   "],
    ["too short a", "Platform engineer, Vienna, full time."],
  ])("writes nothing and scores nothing when the page has %s description", async (_label, jobDescription) => {
    fetchJobDraft.mockResolvedValue({
      job: { title: "Platform Engineer", jobDescription },
      usage: null,
      warning: null,
    });

    const scored = await rescrapeUnscoreableStep({
      jobs: [shortJob()],
      brief: "brief",
      autoSkipCategory: null,
    });

    expect(updateJob).not.toHaveBeenCalled();
    expect(scoreJobSuitability).not.toHaveBeenCalled();
    expect(scored).toEqual([]);
  });

  it.each([
    "processing",
    "skipped",
  ] as const)("leaves a job alone that is %s by the time its turn comes", async (status) => {
    getJobById.mockResolvedValue(shortJob({ status }));

    const scored = await rescrapeUnscoreableStep({
      jobs: [shortJob()],
      brief: "brief",
      autoSkipCategory: "bad_fit",
    });

    expect(fetchJobDraft).not.toHaveBeenCalled();
    expect(updateJob).not.toHaveBeenCalled();
    expect(scoreJobSuitability).not.toHaveBeenCalled();
    expect(scored).toEqual([]);
  });

  it("reports its progress without touching the scored count", async () => {
    await rescrapeUnscoreableStep({
      jobs: [shortJob()],
      brief: "brief",
      autoSkipCategory: null,
    });

    const events = updateProgress.mock.calls.map((call) => call[0]);
    expect(events).toContainEqual(
      expect.objectContaining({ message: "Re-fetching jobs (1/1)..." }),
    );
    for (const event of events) {
      expect(event).not.toHaveProperty("jobsScored");
    }
  });

  it("ends the run when the page reader hit a provider rate limit", async () => {
    fetchJobDraft.mockResolvedValue({
      job: {},
      usage: null,
      warning: "The LLM provider is rate limiting.",
    });
    isRateLimitStopped.mockReturnValue(true);

    await expect(
      rescrapeUnscoreableStep({
        jobs: [shortJob()],
        brief: "brief",
        autoSkipCategory: null,
      }),
    ).rejects.toBeInstanceOf(LlmRateLimitStopError);
  });

  it("does not fetch a job whose URL is not a web address", async () => {
    await rescrapeUnscoreableStep({
      jobs: [shortJob({ jobUrl: "manual://pasted-1" })],
      brief: "brief",
      autoSkipCategory: null,
    });

    expect(fetchJobDraft).not.toHaveBeenCalled();
  });

  it("ends the run on a provider rate limit", async () => {
    scoreJobSuitability.mockRejectedValue(
      new LlmRateLimitStopError({ jobId: "job-1", reason: "rate limited" }),
    );

    await expect(
      rescrapeUnscoreableStep({
        jobs: [shortJob()],
        brief: "brief",
        autoSkipCategory: null,
      }),
    ).rejects.toBeInstanceOf(LlmRateLimitStopError);
  });
});
