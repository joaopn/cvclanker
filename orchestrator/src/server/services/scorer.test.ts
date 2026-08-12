// @vitest-environment node
import type { Job } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callJsonMock = vi.hoisted(() => vi.fn());
const getEffectiveSettingsMock = vi.hoisted(() => vi.fn());

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
  getEffectiveSettings: getEffectiveSettingsMock,
}));

import {
  classifyJob,
  JobNotScoreableError,
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
  getEffectiveSettingsMock.mockReset();
  getEffectiveSettingsMock.mockResolvedValue({
    penalizeMissingSalary: { value: false },
    scoringInstructions: { value: "" },
  });
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

  it("still demotes a salary-less job one tier when the penalty is on", async () => {
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: true },
      scoringInstructions: { value: "" },
    });
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "great_fit", reason: "Strong." },
    });
    const salarylessJob = { ...job, salary: null } as unknown as Job;

    const result = await scoreJobSuitability(salarylessJob, "brief");

    expect(result.category).toBe("very_good_fit");
    expect(result.reason).toContain("missing salary");
  });

  it("refuses a description too short to judge before reading any setting", async () => {
    const thinJob = { ...job, jobDescription: "too short" } as unknown as Job;

    await expect(scoreJobSuitability(thinJob, "brief")).rejects.toBeInstanceOf(
      JobNotScoreableError,
    );
    expect(getEffectiveSettingsMock).not.toHaveBeenCalled();
    expect(callJsonMock).not.toHaveBeenCalled();
  });
});

describe("classifyJob", () => {
  it("sends the caller's model and effort, not the configured ones", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "bad_fit", reason: "No overlap." },
      usage: { promptTokens: 900, completionTokens: 40 },
    });

    const result = await classifyJob(job, "brief", {
      model: "cheap-model",
      instructions: "policy text",
      effort: "low",
    });

    expect(result).toEqual({
      category: "bad_fit",
      reason: "No overlap.",
      usage: { promptTokens: 900, completionTokens: 40 },
    });
    expect(callJsonMock).toHaveBeenCalledTimes(1);
    const sent = callJsonMock.mock.calls[0][0];
    expect(sent.model).toBe("cheap-model");
    expect(sent.effort).toBe("low");
  });

  it("omits effort entirely when the caller does not set one", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "good_fit", reason: "Fine." },
    });

    await classifyJob(job, "brief", {
      model: "cheap-model",
      instructions: "policy text",
    });

    // Not `effort: undefined` — the claude_code spawner falls back to
    // CLAUDE_CODE_EFFORT only when the key is genuinely absent.
    expect("effort" in callJsonMock.mock.calls[0][0]).toBe(false);
  });

  it("never applies the salary penalty, even with the penalty enabled", async () => {
    // Paired with the scoreJobSuitability salary test above: together they pin
    // that the penalty lives on the production path ONLY, which is the single
    // behaviour the classifyJob extraction could have silently moved.
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: true },
      scoringInstructions: { value: "" },
    });
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "great_fit", reason: "Strong." },
    });
    const salarylessJob = { ...job, salary: null } as unknown as Job;

    const result = await classifyJob(salarylessJob, "brief", {
      model: "m",
      instructions: "",
    });

    expect(result.category).toBe("great_fit");
    expect(result.reason).toBe("Strong.");
  });

  it("refuses a job whose description is too short to judge", async () => {
    const thinJob = { ...job, jobDescription: "too short" } as unknown as Job;

    await expect(
      classifyJob(thinJob, "brief", { model: "m", instructions: "" }),
    ).rejects.toBeInstanceOf(JobNotScoreableError);
    expect(callJsonMock).not.toHaveBeenCalled();
  });
});
