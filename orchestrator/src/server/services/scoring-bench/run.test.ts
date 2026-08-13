// @vitest-environment node
import type { BenchConfig, BenchSampleCategory, Job } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const classifyJobMock = vi.hoisted(() => vi.fn());
const getRandomScoreableJobsMock = vi.hoisted(() => vi.fn());
const resetRateLimitBudgetMock = vi.hoisted(() => vi.fn());
const getEffectiveSettingsMock = vi.hoisted(() => vi.fn());
const getPipelineStatusMock = vi.hoisted(() => vi.fn());
const resolveProviderCallMock = vi.hoisted(() => vi.fn());

// Hoisted with the mocks: a plain `class` declaration is not, so the factory
// below would hit its TDZ.
const FakeRateLimitStopError = vi.hoisted(
  () =>
    class FakeRateLimitStopError extends Error {
      name = "LlmRateLimitStopError";
    },
);

vi.mock("@server/db/index", () => ({
  db: {},
  schema: {},
  closeDb: vi.fn(),
}));
vi.mock("@server/repositories/jobs", () => ({
  getRandomScoreableJobs: getRandomScoreableJobsMock,
}));
vi.mock("@server/services/brief", () => ({
  getActivePersonalBrief: vi.fn().mockResolvedValue("brief text"),
}));
vi.mock("@server/services/llm/rate-limit-budget", () => ({
  resetRateLimitBudget: resetRateLimitBudgetMock,
}));
vi.mock("@server/services/scorer", () => ({
  classifyJob: classifyJobMock,
  LlmRateLimitStopError: FakeRateLimitStopError,
  MIN_SCOREABLE_DESCRIPTION_CHARS: 100,
}));
vi.mock("@server/services/llm/provider-credentials", () => ({
  normalizeProviderId: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null,
  resolveProviderCall: resolveProviderCallMock,
}));
vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: getEffectiveSettingsMock,
}));
vi.mock("@server/services/modelSelection", () => ({
  resolveLlmModel: vi.fn().mockResolvedValue("configured-model"),
}));
vi.mock("@server/pipeline/index", () => ({
  getPipelineStatus: getPipelineStatusMock,
}));

import { executeBenchRun } from "./run";
import {
  claimBenchRun,
  getCurrentBenchRun,
  requestBenchCancel,
  resetBenchStoreForTests,
} from "./store";

const ALL_CATEGORIES: BenchSampleCategory[] = [
  "great_fit",
  "very_good_fit",
  "good_fit",
  "bad_fit",
  "unscored",
];

const CONFIGS: BenchConfig[] = [
  {
    id: "cfg-a",
    label: "A",
    provider: "",
    model: "big",
    effort: null,
    inputCostPerMillion: null,
    outputCostPerMillion: null,
  },
  {
    id: "cfg-b",
    label: "B",
    provider: "",
    model: "small",
    effort: "low",
    inputCostPerMillion: null,
    outputCostPerMillion: null,
  },
];

function job(id: string, overrides: Partial<Job> = {}): Job {
  return {
    id,
    title: `Job ${id}`,
    employer: "Acme",
    jobUrl: `https://example.test/${id}`,
    ...overrides,
  } as unknown as Job;
}

beforeEach(() => {
  resetBenchStoreForTests();
  classifyJobMock.mockReset();
  getRandomScoreableJobsMock.mockReset();
  resetRateLimitBudgetMock.mockReset();
  getPipelineStatusMock.mockReset();
  getPipelineStatusMock.mockReturnValue({ isRunning: false });
  resolveProviderCallMock.mockReset();
  resolveProviderCallMock.mockImplementation(async (provider: string) => ({
    provider,
    options: { provider },
    missingReason: null,
  }));
  getEffectiveSettingsMock.mockReset();
  getEffectiveSettingsMock.mockResolvedValue({
    llmRateLimitRetries: { value: 3 },
    scoringInstructions: { value: "policy" },
    scoringConcurrency: { value: 2 },
    llmProvider: { value: "openai" },
    claudeCodeEffort: null,
  });
});

describe("executeBenchRun", () => {
  it("classifies every job under every config without touching the DB", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([job("j1"), job("j2")]);
    classifyJobMock.mockResolvedValue({
      category: "good_fit",
      reason: "ok",
      usage: { promptTokens: 100, completionTokens: 10 },
    });

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 2 });

    expect(classifyJobMock).toHaveBeenCalledTimes(4);
    const finished = getCurrentBenchRun();
    expect(finished?.status).toBe("done");
    expect(
      finished?.cells.filter((cell) => cell.status === "done"),
    ).toHaveLength(4);
    expect(finished?.cells.every((cell) => cell.promptTokens === 100)).toBe(
      true,
    );
  });

  it("passes each config's own model and effort through", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([job("j1")]);
    classifyJobMock.mockResolvedValue({ category: "bad_fit", reason: "no" });

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 1 });

    const sent = classifyJobMock.mock.calls.map((call) => call[2]);
    expect(sent).toContainEqual({
      model: "big",
      instructions: "policy",
      llm: { provider: "openai" },
    });
    // The second config asks for effort "low", but these columns run on the
    // configured provider (openai), which has no such knob — so it is dropped
    // rather than sent and then advertised in the column header.
    expect(sent).toContainEqual({
      model: "small",
      instructions: "policy",
      llm: { provider: "openai" },
    });
  });

  it("keeps going when one cell fails and records the failure", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([job("j1"), job("j2")]);
    classifyJobMock
      .mockRejectedValueOnce(new Error("model refused"))
      .mockResolvedValue({ category: "good_fit", reason: "ok" });

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 2 });

    const finished = getCurrentBenchRun();
    expect(finished?.status).toBe("done");
    expect(
      finished?.cells.filter((cell) => cell.status === "error"),
    ).toHaveLength(1);
    expect(
      finished?.cells.filter((cell) => cell.status === "done"),
    ).toHaveLength(3);
  });

  it("stops the whole run on a rate limit instead of failing every cell", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([
      job("j1"),
      job("j2"),
      job("j3"),
    ]);
    classifyJobMock.mockRejectedValue(
      new FakeRateLimitStopError("session limit reached"),
    );

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 3 });

    const finished = getCurrentBenchRun();
    expect(finished?.status).toBe("stopped");
    expect(finished?.stoppedReason).toContain("session limit");
    // The pool stops pulling work, so most of the 6 cells are never attempted.
    expect(classifyJobMock.mock.calls.length).toBeLessThan(6);
  });

  it("records the model it actually used when a config leaves it blank", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([job("j1")]);
    classifyJobMock.mockResolvedValue({ category: "good_fit", reason: "ok" });

    const run = claimBenchRun(
      [
        {
          id: "cfg-blank",
          label: "Default",
          provider: "",
          model: "",
          effort: null,
          inputCostPerMillion: null,
          outputCostPerMillion: null,
        },
      ],
      ALL_CATEGORIES,
    );
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 1 });

    expect(classifyJobMock.mock.calls[0][2].model).toBe("configured-model");
    expect(getCurrentBenchRun()?.configs[0].model).toBe("configured-model");
  });

  it("records the configured claude_code effort rather than calling it a default", async () => {
    // The effort setting rides into process.env, so a "no effort" config would
    // silently run at the saved level; the run must say which level that was.
    getEffectiveSettingsMock.mockResolvedValue({
      llmRateLimitRetries: { value: 3 },
      scoringInstructions: { value: "policy" },
      scoringConcurrency: { value: 2 },
      llmProvider: { value: "claude_code" },
      claudeCodeEffort: "max",
    });
    getRandomScoreableJobsMock.mockResolvedValue([job("j1")]);
    classifyJobMock.mockResolvedValue({ category: "good_fit", reason: "ok" });

    const run = claimBenchRun(
      [
        {
          id: "cfg-default",
          label: "Default",
          provider: "",
          model: "m",
          effort: null,
          inputCostPerMillion: null,
          outputCostPerMillion: null,
        },
        {
          id: "cfg-low",
          label: "Low",
          provider: "",
          model: "m",
          effort: "low",
          inputCostPerMillion: null,
          outputCostPerMillion: null,
        },
      ],
      ALL_CATEGORIES,
    );
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 1 });

    const efforts = getCurrentBenchRun()?.configs.map((c) => c.effort);
    expect(efforts).toEqual(["max", "low"]);
    expect(classifyJobMock.mock.calls.map((call) => call[2].effort)).toEqual([
      "max",
      "low",
    ]);
  });

  it("leaves the effort unset on providers that have no such knob", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([job("j1")]);
    classifyJobMock.mockResolvedValue({ category: "good_fit", reason: "ok" });

    const run = claimBenchRun(
      [
        {
          id: "cfg-a",
          label: "A",
          provider: "",
          model: "m",
          effort: null,
          inputCostPerMillion: null,
          outputCostPerMillion: null,
        },
      ],
      ALL_CATEGORIES,
    );
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 1 });

    expect(getCurrentBenchRun()?.configs[0].effort).toBeNull();
    expect("effort" in classifyJobMock.mock.calls[0][2]).toBe(false);
  });

  it("leaves a running pipeline's rate-limit latch alone", async () => {
    getPipelineStatusMock.mockReturnValue({ isRunning: true });
    getRandomScoreableJobsMock.mockResolvedValue([]);

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 1 });

    expect(resetRateLimitBudgetMock).not.toHaveBeenCalled();
  });

  it("carries each sampled job's saved category and reason onto the run", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([
      job("j1", {
        suitabilityCategory: "good_fit",
        suitabilityReason: "Scored last week.",
      }),
      job("j2"),
    ]);
    classifyJobMock.mockResolvedValue({ category: "bad_fit", reason: "no" });

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 2 });

    const sampled = getCurrentBenchRun()?.jobs;
    expect(sampled?.[0].storedCategory).toBe("good_fit");
    expect(sampled?.[0].storedReason).toBe("Scored last week.");
    expect(sampled?.[1].storedCategory).toBeNull();
  });

  it("passes a category filter to the sampler, and omits it when absent", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([]);

    const filtered = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!filtered) throw new Error("claim failed");
    await executeBenchRun({
      run: filtered,
      sampleSize: 3,
      categories: ["bad_fit", "unscored"],
    });
    expect(getRandomScoreableJobsMock.mock.calls[0][0].categories).toEqual([
      "bad_fit",
      "unscored",
    ]);

    const unfiltered = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!unfiltered) throw new Error("claim failed");
    await executeBenchRun({ run: unfiltered, sampleSize: 3 });
    expect("categories" in getRandomScoreableJobsMock.mock.calls[1][0]).toBe(
      false,
    );
  });

  it("resets the rate-limit budget so an old latch does not fail the run", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([]);

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 5 });

    expect(resetRateLimitBudgetMock).toHaveBeenCalledWith(3);
  });

  it("finishes cleanly when nothing in the database is scoreable", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([]);

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 5 });

    const finished = getCurrentBenchRun();
    expect(finished?.status).toBe("done");
    expect(finished?.jobs).toEqual([]);
    expect(classifyJobMock).not.toHaveBeenCalled();
  });

  it("marks a cancelled run cancelled, not stopped", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([job("j1"), job("j2")]);
    classifyJobMock.mockImplementation(async () => {
      requestBenchCancel();
      return { category: "good_fit", reason: "ok" };
    });

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 2 });

    expect(getCurrentBenchRun()?.status).toBe("cancelled");
  });

  it("always finishes the run, even when the sample query throws", async () => {
    getRandomScoreableJobsMock.mockRejectedValue(new Error("db is gone"));

    const run = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 2 });

    // A run left "running" would 409 every later attempt until a restart.
    const finished = getCurrentBenchRun();
    expect(finished?.status).toBe("stopped");
    expect(finished?.stoppedReason).toContain("db is gone");
  });
});

describe("claimBenchRun", () => {
  it("refuses a second run while one is active", () => {
    expect(claimBenchRun(CONFIGS, ALL_CATEGORIES)).not.toBeNull();
    expect(claimBenchRun(CONFIGS, ALL_CATEGORIES)).toBeNull();
  });

  it("allows a new run once the previous one finished", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([]);
    const first = claimBenchRun(CONFIGS, ALL_CATEGORIES);
    if (!first) throw new Error("claim failed");
    await executeBenchRun({ run: first, sampleSize: 1 });

    expect(claimBenchRun(CONFIGS, ALL_CATEGORIES)).not.toBeNull();
  });
});

describe("executeBenchRun across providers", () => {
  function configOn(id: string, provider: string, model = ""): BenchConfig {
    return {
      id,
      label: id,
      provider,
      model,
      effort: null,
      inputCostPerMillion: null,
      outputCostPerMillion: null,
    };
  }

  it("resolves each provider once and calls its columns with its own credentials", async () => {
    resolveProviderCallMock.mockImplementation(async (provider: string) => ({
      provider,
      options: { provider, apiKey: `${provider}-key`, baseUrl: null },
      missingReason: null,
    }));
    getRandomScoreableJobsMock.mockResolvedValue([job("j1")]);
    classifyJobMock.mockResolvedValue({ category: "good_fit", reason: "ok" });

    const run = claimBenchRun(
      [
        configOn("cfg-a", "gemini", "flash"),
        configOn("cfg-b", "gemini", "pro"),
        configOn("cfg-c", "claude_code"),
      ],
      ALL_CATEGORIES,
    );
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 1 });

    // Two distinct providers, resolved once each — not once per cell.
    expect(resolveProviderCallMock).toHaveBeenCalledTimes(2);
    const sent = classifyJobMock.mock.calls.map((call) => call[2].llm);
    expect(sent).toContainEqual({
      provider: "gemini",
      apiKey: "gemini-key",
      baseUrl: null,
    });
    expect(sent).toContainEqual({
      provider: "claude_code",
      apiKey: "claude_code-key",
      baseUrl: null,
    });
  });

  it("stops before drawing a sample when a provider has no usable credential", async () => {
    resolveProviderCallMock.mockImplementation(async (provider: string) => ({
      provider,
      options: { provider },
      missingReason:
        provider === "openrouter"
          ? "No API key is saved for openrouter."
          : null,
    }));
    getRandomScoreableJobsMock.mockResolvedValue([job("j1")]);

    const run = claimBenchRun(
      [configOn("cfg-a", "openai", "gpt"), configOn("cfg-b", "openrouter")],
      ALL_CATEGORIES,
    );
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 1 });

    const finished = getCurrentBenchRun();
    expect(finished?.status).toBe("stopped");
    expect(finished?.stoppedReason).toContain("openrouter");
    // Nothing was drawn and nothing was spent on the columns that WOULD work.
    expect(getRandomScoreableJobsMock).not.toHaveBeenCalled();
    expect(classifyJobMock).not.toHaveBeenCalled();
  });

  it("resolves a blank model per provider, not to the scoring model", async () => {
    getRandomScoreableJobsMock.mockResolvedValue([job("j1")]);
    classifyJobMock.mockResolvedValue({ category: "good_fit", reason: "ok" });

    const run = claimBenchRun(
      [configOn("cfg-configured", ""), configOn("cfg-other", "gemini")],
      ALL_CATEGORIES,
    );
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 1 });

    const configs = getCurrentBenchRun()?.configs ?? [];
    // The configured column keeps the scoring model; the other one takes its
    // OWN provider's default, since the scoring model belongs to a different
    // provider entirely and would simply not exist there.
    expect(configs[0]).toMatchObject({
      provider: "openai",
      model: "configured-model",
    });
    expect(configs[1]?.provider).toBe("gemini");
    expect(configs[1]?.model).not.toBe("configured-model");
    expect(configs[1]?.model).not.toBe("");
  });

  it("records no effort for a column that is not on claude_code", async () => {
    getEffectiveSettingsMock.mockResolvedValue({
      llmRateLimitRetries: { value: 3 },
      scoringInstructions: { value: "policy" },
      scoringConcurrency: { value: 2 },
      llmProvider: { value: "claude_code" },
      claudeCodeEffort: "high",
    });
    getRandomScoreableJobsMock.mockResolvedValue([job("j1")]);
    classifyJobMock.mockResolvedValue({ category: "good_fit", reason: "ok" });

    const run = claimBenchRun(
      [configOn("cfg-cc", ""), configOn("cfg-gemini", "gemini", "flash")],
      ALL_CATEGORIES,
    );
    if (!run) throw new Error("claim failed");
    await executeBenchRun({ run, sampleSize: 1 });

    const configs = getCurrentBenchRun()?.configs ?? [];
    expect(configs[0]?.effort).toBe("high");
    // The saved claude_code effort must not be stamped on a Gemini column that
    // never had the flag.
    expect(configs[1]?.effort).toBeNull();
  });
});
