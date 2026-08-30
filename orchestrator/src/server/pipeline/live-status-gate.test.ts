import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/pipeline", () => ({
  createPipelineRun: vi.fn(async () => ({
    id: "run-live-status-1",
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

describe.sequential("pipeline live-status refresh gate", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-pipeline-live-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  const setSetting = async (value: "1" | "0") => {
    const settingsRepo = await import("../repositories/settings");
    await settingsRepo.setSetting("liveStatusRefreshEnabled", value);
  };

  it("is off by default", async () => {
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    const result = await pipeline.runPipeline({ sources: [] });

    expect(result.success).toBe(true);
    expect(vi.mocked(steps.refreshLiveStatusStep)).not.toHaveBeenCalled();
  });

  it("runs when the standing setting is on and the run says nothing", async () => {
    await setSetting("1");
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    await pipeline.runPipeline({ sources: [] });

    expect(vi.mocked(steps.refreshLiveStatusStep)).toHaveBeenCalledTimes(1);
  });

  it("lets one run turn it on without the setting", async () => {
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    await pipeline.runPipeline({ sources: [], refreshLiveStatus: true });

    expect(vi.mocked(steps.refreshLiveStatusStep)).toHaveBeenCalledTimes(1);
  });

  it("lets one run turn it off against the setting", async () => {
    await setSetting("1");
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    await pipeline.runPipeline({ sources: [], refreshLiveStatus: false });

    expect(vi.mocked(steps.refreshLiveStatusStep)).not.toHaveBeenCalled();
  });

  it("never runs on a partial re-run, whatever the setting or the request says", async () => {
    await setSetting("1");
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    // The two "retry this source" buttons send `partial` with no other
    // overrides; a live-status sweep is unrelated to the source being retried
    // and would silently add minutes to a click meant to be cheap.
    await pipeline.runPipeline({
      sources: [],
      partial: true,
      refreshLiveStatus: true,
    });

    expect(vi.mocked(steps.refreshLiveStatusStep)).not.toHaveBeenCalled();
  });

  it("runs it after scoring and before selection", async () => {
    const order: string[] = [];
    const steps = await import("./steps");
    vi.mocked(steps.scoreJobsStep).mockImplementation(async () => {
      order.push("score");
      return { unprocessedJobs: [], scoredJobs: [] };
    });
    vi.mocked(steps.refreshLiveStatusStep).mockImplementation(async () => {
      order.push("live_status");
      return { checked: 0, failed: 0, closed: 0, unchecked: 0 };
    });
    vi.mocked(steps.selectJobsStep).mockImplementation(async () => {
      order.push("select");
      return [];
    });
    const pipeline = await import("./orchestrator");

    await pipeline.runPipeline({ sources: [], refreshLiveStatus: true });

    expect(order).toEqual(["score", "live_status", "select"]);
  });
});
