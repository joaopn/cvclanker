// @vitest-environment node
import type { Job } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callJsonMock = vi.hoisted(() => vi.fn());
const getEffectiveSettingsMock = vi.hoisted(() => vi.fn());
const resolveProviderCallMock = vi.hoisted(() => vi.fn());

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
vi.mock("./llm/provider-credentials", () => ({
  resolveProviderCall: resolveProviderCallMock,
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
      model: "stub-model",
      effort: null,
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

  it("reports the effort only when the configured provider has one", async () => {
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: false },
      scoringInstructions: { value: "" },
      llmProvider: { value: "claude_code" },
      claudeCodeEffort: "high",
    });
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "good_fit", reason: "Fine." },
    });

    const onClaudeCode = await scoreJobSuitability(job, "brief");
    expect(onClaudeCode.effort).toBe("high");

    // Same saved effort, different provider: the CLI flag is never sent, so
    // recording a level would claim a knob that was not turned.
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: false },
      scoringInstructions: { value: "" },
      llmProvider: { value: "openai" },
      claudeCodeEffort: "high",
    });

    const onOpenAi = await scoreJobSuitability(job, "brief");
    expect(onOpenAi.effort).toBeNull();
    expect(onOpenAi.model).toBe("stub-model");
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

describe("two-stage scoring", () => {
  const SETTINGS_WITH_SCREEN = {
    penalizeMissingSalary: { value: false },
    scoringInstructions: { value: "" },
    llmProvider: { value: "openai" },
    scorerPrefilterModel: { value: "cheap-model" },
    scorerPrefilterProvider: { value: null },
    scorerPrefilterEffort: { value: null },
  };

  beforeEach(() => {
    resolveProviderCallMock.mockReset();
    resolveProviderCallMock.mockImplementation(async (provider: unknown) => ({
      provider: provider ?? "openai",
      options: { provider: provider ?? "openai" },
      missingReason: null,
    }));
  });

  it("does not screen when no pre-filter model is configured", async () => {
    // The default settings carry no pre-filter, so the pipeline path must be
    // byte-identical to what it was before two-stage scoring existed.
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "good_fit", reason: "fine" },
    });

    await scoreJobSuitability(job, "brief", { prefilter: true });

    expect(callJsonMock).toHaveBeenCalledTimes(1);
  });

  it("ignores the screen entirely for callers that did not opt in", async () => {
    getEffectiveSettingsMock.mockResolvedValue(SETTINGS_WITH_SCREEN);
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "good_fit", reason: "fine" },
    });

    // No options at all — Recalculate match, a rescrape, a pasted URL.
    await scoreJobSuitability(job, "brief");

    expect(callJsonMock).toHaveBeenCalledTimes(1);
    expect(callJsonMock.mock.calls[0][0].model).toBe("stub-model");
  });

  it("stops at the screen when it calls the job a bad fit", async () => {
    getEffectiveSettingsMock.mockResolvedValue(SETTINGS_WITH_SCREEN);
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "bad_fit", reason: "Wrong stack." },
    });

    const result = await scoreJobSuitability(job, "brief", { prefilter: true });

    expect(callJsonMock).toHaveBeenCalledTimes(1);
    expect(callJsonMock.mock.calls[0][0].model).toBe("cheap-model");
    expect(result.category).toBe("bad_fit");
    // The reason has to say which model decided, or a screened-out job is
    // indistinguishable from one the main model actually read.
    expect(result.reason).toContain("Wrong stack.");
    expect(result.reason).toContain("cheap-model");
    // The screen is what decided, so it is what gets recorded — naming the
    // main model here would credit a call that never happened.
    expect(result.model).toBe("cheap-model");
    expect(result.effort).toBeNull();
  });

  it("records the screen's inherited effort when it runs on claude_code", async () => {
    getEffectiveSettingsMock.mockResolvedValue({
      ...SETTINGS_WITH_SCREEN,
      scorerPrefilterProvider: { value: "claude_code" },
      claudeCodeEffort: "medium",
    });
    resolveProviderCallMock.mockResolvedValue({
      provider: "claude_code",
      options: { provider: "claude_code" },
      missingReason: null,
    });
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "bad_fit", reason: "No." },
    });

    const result = await scoreJobSuitability(job, "brief", { prefilter: true });

    // No per-screen override, so the CLI falls back to the saved effort — the
    // record has to say the same thing the spawner did.
    expect("effort" in callJsonMock.mock.calls[0][0]).toBe(false);
    expect(result.effort).toBe("medium");
  });

  it("discards a non-bad screen verdict and lets the main model decide", async () => {
    getEffectiveSettingsMock.mockResolvedValue(SETTINGS_WITH_SCREEN);
    callJsonMock
      .mockResolvedValueOnce({
        success: true,
        data: { category: "great_fit", reason: "Screen liked it." },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { category: "good_fit", reason: "Main model was cooler." },
      });

    const result = await scoreJobSuitability(job, "brief", { prefilter: true });

    expect(callJsonMock).toHaveBeenCalledTimes(2);
    expect(callJsonMock.mock.calls[1][0].model).toBe("stub-model");
    // The screen's verdict is thrown away wholesale — category AND reason.
    expect(result.category).toBe("good_fit");
    expect(result.reason).toBe("Main model was cooler.");
    expect(result.model).toBe("stub-model");
  });

  it("falls through to the main model when the screen fails", async () => {
    getEffectiveSettingsMock.mockResolvedValue(SETTINGS_WITH_SCREEN);
    callJsonMock
      .mockResolvedValueOnce({
        success: false,
        code: "unknown",
        error: "screen exploded",
      })
      .mockResolvedValueOnce({
        success: true,
        data: { category: "very_good_fit", reason: "Main model is fine." },
      });

    const result = await scoreJobSuitability(job, "brief", { prefilter: true });

    // Fail OPEN: a broken screen must never delete jobs.
    expect(callJsonMock).toHaveBeenCalledTimes(2);
    expect(result.category).toBe("very_good_fit");
  });

  it("propagates a rate limit from the screen instead of paying twice", async () => {
    getEffectiveSettingsMock.mockResolvedValue(SETTINGS_WITH_SCREEN);
    callJsonMock.mockResolvedValue({
      success: false,
      code: "rate_limited",
      error: "session limit",
    });

    await expect(
      scoreJobSuitability(job, "brief", { prefilter: true }),
    ).rejects.toBeInstanceOf(LlmRateLimitStopError);
    // The second call would hit the same account-wide wall.
    expect(callJsonMock).toHaveBeenCalledTimes(1);
  });

  it("skips a screen that resolves to the very same call as the main model", async () => {
    getEffectiveSettingsMock.mockResolvedValue({
      ...SETTINGS_WITH_SCREEN,
      scorerPrefilterModel: { value: "stub-model" },
    });
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "good_fit", reason: "fine" },
    });

    await scoreJobSuitability(job, "brief", { prefilter: true });

    // Same provider, same model, no effort — screening with it would pay twice
    // for one answer.
    expect(callJsonMock).toHaveBeenCalledTimes(1);
  });

  it("skips the screen when its provider has no usable credential", async () => {
    getEffectiveSettingsMock.mockResolvedValue({
      ...SETTINGS_WITH_SCREEN,
      scorerPrefilterProvider: { value: "openrouter" },
    });
    resolveProviderCallMock.mockResolvedValue({
      provider: "openrouter",
      options: { provider: "openrouter" },
      missingReason: "No API key is saved for openrouter.",
    });
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "good_fit", reason: "fine" },
    });

    const result = await scoreJobSuitability(job, "brief", { prefilter: true });

    // Unusable screen means no screen — not a failed job.
    expect(callJsonMock).toHaveBeenCalledTimes(1);
    expect(callJsonMock.mock.calls[0][0].model).toBe("stub-model");
    expect(result.category).toBe("good_fit");
  });

  it("calls the screen on its own provider, with its own effort", async () => {
    getEffectiveSettingsMock.mockResolvedValue({
      ...SETTINGS_WITH_SCREEN,
      scorerPrefilterProvider: { value: "claude_code" },
      scorerPrefilterEffort: { value: "low" },
    });
    resolveProviderCallMock.mockResolvedValue({
      provider: "claude_code",
      options: { provider: "claude_code" },
      missingReason: null,
    });
    callJsonMock.mockResolvedValue({
      success: true,
      data: { category: "bad_fit", reason: "No." },
    });

    await scoreJobSuitability(job, "brief", { prefilter: true });

    expect(callJsonMock).toHaveBeenCalledTimes(1);
    expect(callJsonMock.mock.calls[0][0].effort).toBe("low");
  });
});
