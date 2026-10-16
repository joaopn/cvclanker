// @vitest-environment node
import { createJob } from "@shared/testing/factories";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUnscoredDiscoveredJobs = vi.fn();
const updateJob = vi.fn();
const getSetting = vi.fn();
const scoreJobSuitability = vi.fn();

vi.mock("@server/repositories/jobs", () => ({
  getUnscoredDiscoveredJobs: (...args: unknown[]) =>
    getUnscoredDiscoveredJobs(...args),
  updateJob: (...args: unknown[]) => updateJob(...args),
}));
vi.mock("@server/repositories/settings", () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
}));
vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: async () => ({ scoringConcurrency: { value: 1 } }),
}));
vi.mock("@server/services/scorer", () => ({
  JobNotScoreableError: class extends Error {},
  JobScoringFailedError: class extends Error {},
  LlmRateLimitStopError: class extends Error {},
  scoreJobSuitability: (...args: unknown[]) => scoreJobSuitability(...args),
}));
vi.mock("../progress", () => ({
  updateProgress: vi.fn(),
  progressHelpers: { scoringJob: vi.fn(), scoringComplete: vi.fn() },
}));

import { scoreJobsStep } from "./score-jobs";

describe("scoreJobsStep auto-skip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUnscoredDiscoveredJobs.mockResolvedValue([
      createJob({
        id: "job-1",
        status: "discovered",
        suitabilityCategory: null,
      }),
    ]);
    // The setting is ON, so a step that still read it instead of its argument
    // would skip in the "null" case below.
    getSetting.mockImplementation(async (key: string) =>
      key === "autoSkipCategory" ? "good_fit" : null,
    );
    scoreJobSuitability.mockResolvedValue({
      category: "bad_fit",
      reason: "no",
      model: "m",
      effort: null,
    });
  });

  it("skips a job at or below the run's tier", async () => {
    await scoreJobsStep({ brief: "", autoSkipCategory: "bad_fit" });

    expect(updateJob.mock.calls[0][1].status).toBe("skipped");
  });

  it("leaves the job in the Inbox when the run skips nothing", async () => {
    await scoreJobsStep({ brief: "", autoSkipCategory: null });

    expect(updateJob.mock.calls[0][1]).not.toHaveProperty("status");
  });
});
