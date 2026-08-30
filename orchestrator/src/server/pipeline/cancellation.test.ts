import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DiscoverResult = {
  discoveredJobs: [];
  sourceErrors: [];
  scrapedSources: [];
  scrapeStartedAt: string;
};

const stepState = vi.hoisted(() => {
  let resolveDiscover: ((value: DiscoverResult) => void) | null = null;
  return {
    setResolver: (fn: (value: DiscoverResult) => void) => {
      resolveDiscover = fn;
    },
    resolveDiscover: () =>
      resolveDiscover?.({
        discoveredJobs: [],
        sourceErrors: [],
        scrapedSources: [],
        scrapeStartedAt: "2026-01-01T00:00:00.000Z",
      }),
  };
});

vi.mock("../repositories/pipeline", () => ({
  createPipelineRun: vi.fn(async () => ({
    id: "run-cancel-1",
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
  discoverJobsStep: vi.fn(
    () =>
      new Promise<DiscoverResult>((resolve) => {
        stepState.setResolver(resolve);
      }),
  ),
  importJobsStep: vi.fn(async () => ({
    created: 0,
    skipped: 0,
    reposted: 0,
    rejected: 0,
  })),
  scoreJobsStep: vi.fn(async () => ({ unprocessedJobs: [], scoredJobs: [] })),
  selectJobsStep: vi.fn(() => []),
  processJobsStep: vi.fn(async () => ({ processedCount: 0 })),
  refreshLiveStatusStep: vi.fn(async () => ({
    checked: 0,
    failed: 0,
    closed: 0,
    unchecked: 0,
  })),
}));

describe.sequential("pipeline cancellation", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-pipeline-cancel-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("marks run as cancelled at checkpoint and resets running state", async () => {
    const pipeline = await import("./orchestrator");
    const pipelineRepo = await import("../repositories/pipeline");
    const steps = await import("./steps");

    const runPromise = pipeline.runPipeline({ sources: [] });

    await Promise.resolve();

    const cancelRequest = pipeline.requestPipelineCancel();
    expect(cancelRequest.accepted).toBe(true);
    expect([null, "run-cancel-1"]).toContain(cancelRequest.pipelineRunId);
    expect(pipeline.isPipelineCancelRequested()).toBe(true);

    const duplicateRequest = pipeline.requestPipelineCancel();
    expect(duplicateRequest.accepted).toBe(true);
    expect(duplicateRequest.alreadyRequested).toBe(true);

    stepState.resolveDiscover();
    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cancelled");
    expect(vi.mocked(steps.importJobsStep)).not.toHaveBeenCalled();
    expect(vi.mocked(pipelineRepo.updatePipelineRun)).toHaveBeenCalledWith(
      "run-cancel-1",
      expect.objectContaining({
        status: "cancelled",
      }),
    );
    expect(pipeline.getPipelineStatus().isRunning).toBe(false);
    expect(pipeline.isPipelineCancelRequested()).toBe(false);
  });
});
