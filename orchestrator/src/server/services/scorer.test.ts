// @vitest-environment node
import type { Job } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
  },
}));
vi.mock("./prompts", () => ({
  loadPrompt: vi.fn().mockResolvedValue({
    name: "job-score",
    description: "",
    system: "stub-system",
    user: "stub-user",
    modelHints: {},
  }),
}));
vi.mock("./modelSelection", () => ({
  resolveLlmModel: vi.fn().mockResolvedValue("stub-model"),
}));
vi.mock("./settings", () => ({
  getEffectiveSettings: vi.fn().mockResolvedValue({
    penalizeMissingSalary: { value: false },
    scoringInstructions: { value: "" },
  }),
}));

import {
  JobScoringFailedError,
  LlmRateLimitStopError,
  scoreJobSuitability,
} from "./scorer";

const job = {
  id: "job-1",
  title: "Backend Engineer",
  employer: "Acme",
  salary: "100k",
  jobDescription: "x".repeat(500),
} as unknown as Job;

beforeEach(() => {
  callJsonMock.mockReset();
});

describe("scoreJobSuitability failure handling", () => {
  it("stops on a rate limit instead of inventing a score", () => {
    // The bug: this path used to keyword-match the job and stamp it
    // "(API key not configured)", writing a fabricated category to the DB.
    callJsonMock.mockResolvedValue({
      success: false,
      code: "rate_limited",
      error: "You've hit your session limit · resets 2:10am (UTC) (HTTP 429)",
    });

    return expect(scoreJobSuitability(job, "brief")).rejects.toBeInstanceOf(
      LlmRateLimitStopError,
    );
  });

  it("leaves the job unscored on any other failure", async () => {
    callJsonMock.mockResolvedValue({
      success: false,
      code: "auth",
      error: "LLM API key not configured",
    });

    await expect(scoreJobSuitability(job, "brief")).rejects.toBeInstanceOf(
      JobScoringFailedError,
    );
  });

  it("leaves the job unscored when the model returns a bogus category", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "amazing_fit", reason: "sure" },
    });

    await expect(scoreJobSuitability(job, "brief")).rejects.toBeInstanceOf(
      JobScoringFailedError,
    );
  });

  it("still returns a real score on success", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "good_fit", reason: "Solid overlap." },
    });

    await expect(scoreJobSuitability(job, "brief")).resolves.toEqual({
      category: "good_fit",
      reason: "Solid overlap.",
    });
  });
});
