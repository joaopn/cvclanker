import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/pipeline", () => ({
  createPipelineRun: vi.fn(async () => ({
    id: "run-tailor-1",
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
}));

describe.sequential("pipeline auto-tailoring gate", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-pipeline-tailor-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("skips processJobsStep when enableAutoTailoring is false", async () => {
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    const result = await pipeline.runPipeline({
      sources: [],
      enableAutoTailoring: false,
    });

    expect(result.success).toBe(true);
    expect(result.jobsProcessed).toBe(0);
    expect(vi.mocked(steps.processJobsStep)).not.toHaveBeenCalled();
  });

  it("runs processJobsStep when enableAutoTailoring is true", async () => {
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    const result = await pipeline.runPipeline({
      sources: [],
      enableAutoTailoring: true,
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(steps.processJobsStep)).toHaveBeenCalledTimes(1);
  });

  it("defaults to off when enableAutoTailoring and the setting are unset", async () => {
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    const result = await pipeline.runPipeline({ sources: [] });

    expect(result.success).toBe(true);
    expect(vi.mocked(steps.processJobsStep)).not.toHaveBeenCalled();
  });
});
