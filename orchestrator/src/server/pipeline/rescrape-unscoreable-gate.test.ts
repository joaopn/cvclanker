import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/pipeline", () => ({
  createPipelineRun: vi.fn(async () => ({
    id: "run-rescrape-1",
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
  loadBriefStep: vi.fn(async () => "brief"),
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
  scoreJobsStep: vi.fn(async () => ({
    unprocessedJobs: [],
    scoredJobs: [],
    unscoreableJobs: [],
  })),
  rescrapeUnscoreableStep: vi.fn(async () => []),
  selectJobsStep: vi.fn(async () => []),
  processJobsStep: vi.fn(async () => ({ processedCount: 0 })),
  refreshLiveStatusStep: vi.fn(async () => ({
    checked: 0,
    failed: 0,
    closed: 0,
    unchecked: 0,
  })),
}));

describe.sequential("pipeline re-fetch of unscoreable jobs", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-pipeline-rescrape-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  // One job already unscored before the run, one the run's import creates;
  // scoring reports both as unscoreable.
  const arrange = async () => {
    const jobsRepo = await import("../repositories/jobs");
    const steps = await import("./steps");
    const oldJob = await jobsRepo.createJob({
      source: "linkedin",
      title: "Old Role",
      employer: "Acme",
      jobUrl: "https://jobs.example.com/view/old",
      jobDescription: "Short.",
    });
    let newJobId = "";
    vi.mocked(steps.importJobsStep).mockImplementation(async () => {
      const created = await jobsRepo.createJob({
        source: "linkedin",
        title: "New Role",
        employer: "Acme",
        jobUrl: "https://jobs.example.com/view/new",
        jobDescription: "Short.",
      });
      newJobId = created.id;
      return { created: 1, skipped: 0, reposted: 0, rejected: 0 };
    });
    vi.mocked(steps.scoreJobsStep).mockImplementation(async () => {
      const unscoreableJobs = await jobsRepo.getUnscoredDiscoveredJobs();
      return {
        unprocessedJobs: unscoreableJobs,
        scoredJobs: [],
        unscoreableJobs,
      };
    });
    return { oldJob, newJobId: () => newJobId, steps };
  };

  it("does not re-fetch when the setting is off", async () => {
    const { steps } = await arrange();
    const pipeline = await import("./orchestrator");

    const result = await pipeline.runPipeline({ sources: [] });

    expect(result.success).toBe(true);
    expect(vi.mocked(steps.rescrapeUnscoreableStep)).not.toHaveBeenCalled();
  });

  it("re-fetches only the jobs this run found, and selection sees what it scored", async () => {
    const settingsRepo = await import("../repositories/settings");
    await settingsRepo.setSetting("rescrapeUnscoreableJobs", "1");
    const { oldJob, newJobId, steps } = await arrange();
    vi.mocked(steps.rescrapeUnscoreableStep).mockImplementation(
      async ({ jobs }) =>
        jobs.map((job) => ({
          ...job,
          suitabilityCategory: "good_fit" as const,
          suitabilityReason: "fits",
        })),
    );
    const pipeline = await import("./orchestrator");

    const result = await pipeline.runPipeline({ sources: [] });

    expect(result.success).toBe(true);
    const call = vi
      .mocked(steps.rescrapeUnscoreableStep)
      .mock.calls.at(-1)?.[0];
    expect(call?.jobs.map((job) => job.id)).toEqual([newJobId()]);
    expect(call?.jobs.map((job) => job.id)).not.toContain(oldJob.id);
    const selection = vi.mocked(steps.selectJobsStep).mock.calls.at(-1)?.[0];
    expect(selection?.scoredJobs.map((job) => job.id)).toEqual([newJobId()]);
  });
});
