import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineRunSavedDetails } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/pipeline", () => ({
  createPipelineRun: vi.fn(async () => ({
    id: "run-auto-skip-1",
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
    jobsDiscovered: 0,
    jobsProcessed: 0,
    errorMessage: null,
  })),
  updatePipelineRun: vi.fn(async () => undefined),
}));

vi.mock("./steps", () => ({
  loadBriefStep: vi.fn(async () => ""),
  discoverJobsStep: vi.fn(async () => ({
    discoveredJobs: [],
    sourceErrors: [],
    scrapedSources: [],
    scrapeStartedAt: "2026-01-01T00:00:00.000Z",
  })),
  importJobsStep: vi.fn(async () => ({
    created: 0,
    skipped: 0,
    reposted: 0,
    rejected: 0,
  })),
  scoreJobsStep: vi.fn(async () => ({ unprocessedJobs: [], scoredJobs: [] })),
  selectJobsStep: vi.fn(async () => []),
  processJobsStep: vi.fn(async () => ({ processedCount: 0 })),
  refreshLiveStatusStep: vi.fn(async () => ({
    checked: 0,
    failed: 0,
    closed: 0,
    unchecked: 0,
  })),
}));

describe.sequential("pipeline per-run auto-skip", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-pipeline-autoskip-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  const setThreshold = async (value: string) => {
    const settingsRepo = await import("../repositories/settings");
    await settingsRepo.setSetting("autoSkipCategory", value);
  };

  const skipTierOfRun = async (
    config: Parameters<typeof import("./orchestrator")["runPipeline"]>[0] = {},
  ) => {
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");
    const result = await pipeline.runPipeline({ sources: [], ...config });
    expect(result.success).toBe(true);
    const call = vi.mocked(steps.scoreJobsStep).mock.calls.at(-1)?.[0];
    expect(call).toBeDefined();
    return call?.autoSkipCategory;
  };

  it("follows the setting when the run says nothing", async () => {
    expect(await skipTierOfRun()).toBeNull();
    await setThreshold("good_fit");
    expect(await skipTierOfRun()).toBe("good_fit");
  });

  it("skips bad matches when ticked with the setting off", async () => {
    expect(await skipTierOfRun({ autoSkipBadMatches: true })).toBe("bad_fit");
  });

  it("keeps the setting's wider tier when ticked", async () => {
    await setThreshold("good_fit");
    expect(await skipTierOfRun({ autoSkipBadMatches: true })).toBe("good_fit");
  });

  it("skips nothing when unticked against the setting", async () => {
    await setThreshold("good_fit");
    expect(await skipTierOfRun({ autoSkipBadMatches: false })).toBeNull();
  });

  it("records the tier the run used, not the setting", async () => {
    const pipelineRepo = await import("../repositories/pipeline");
    await skipTierOfRun({ autoSkipBadMatches: true });
    const call = vi
      .mocked(pipelineRepo.createPipelineRun)
      .mock.calls.at(-1) as unknown as [
      { savedDetails?: PipelineRunSavedDetails | null },
    ];
    const saved = call?.[0].savedDetails;
    expect(saved?.effectiveConfig.autoSkipCategory).toBe("bad_fit");
  });
});
