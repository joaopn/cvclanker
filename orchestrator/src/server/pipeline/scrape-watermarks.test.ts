import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/pipeline", () => ({
  createPipelineRun: vi.fn(async () => ({
    id: "run-watermark-1",
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
    jobsDiscovered: 0,
    jobsProcessed: 0,
    errorMessage: null,
  })),
  updatePipelineRun: vi.fn(async () => undefined),
}));

const SCRAPE_STARTED_AT = "2026-08-16T11:09:49.000Z";

vi.mock("./steps", () => ({
  loadBriefStep: vi.fn(async () => ""),
  discoverJobsStep: vi.fn(async () => ({
    discoveredJobs: [],
    sourceErrors: [],
    scrapedSources: [
      { sourceKey: "jobspy", windowDays: 30, policyWindowDays: 30 },
      { sourceKey: "apify:abc", windowDays: 30, policyWindowDays: 30 },
    ],
    scrapeStartedAt: SCRAPE_STARTED_AT,
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

/**
 * The watermark write is per-leg and lives inside `runPipeline`, which a
 * multi-profile chain calls once per entry with that entry's own config
 * (`runProfileSequence` adds no per-leg branching of its own). So driving
 * `runPipeline` twice, in order, is the faithful shape of a chain here — and
 * the first leg is the one a real run reported as having no watermarks at all.
 */
describe.sequential("pipeline scrape watermarks", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-pipeline-watermark-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("records a watermark per source for a run with the flag on", async () => {
    const pipeline = await import("./orchestrator");
    const watermarks = await import("../repositories/source-scrape-watermarks");

    const result = await pipeline.runPipeline({
      sources: [],
      profileId: "profile-1",
      scrapeSinceLastRun: true,
    });

    expect(result.success).toBe(true);
    expect(await watermarks.getScrapeWatermarks("profile-1")).toEqual(
      new Map([
        ["jobspy", SCRAPE_STARTED_AT],
        ["apify:abc", SCRAPE_STARTED_AT],
      ]),
    );
  });

  it("records them for the FIRST profile of a chain, not just later ones", async () => {
    const pipeline = await import("./orchestrator");
    const watermarks = await import("../repositories/source-scrape-watermarks");

    for (const profileId of ["profile-first", "profile-second"]) {
      const result = await pipeline.runPipeline({
        sources: [],
        profileId,
        scrapeSinceLastRun: true,
      });
      expect(result.success).toBe(true);
    }

    expect((await watermarks.getScrapeWatermarks("profile-first")).size).toBe(
      2,
    );
    expect((await watermarks.getScrapeWatermarks("profile-second")).size).toBe(
      2,
    );
  });

  /**
   * The mark records what a run COVERED, so a run with the flag off still moved
   * the boundary — gating the write on the flag would leave a later narrowing
   * measuring against a mark that ignores every run in between.
   */
  it("records them for a run with the flag off", async () => {
    const pipeline = await import("./orchestrator");
    const watermarks = await import("../repositories/source-scrape-watermarks");

    const result = await pipeline.runPipeline({
      sources: [],
      profileId: "profile-flag-off",
      scrapeSinceLastRun: false,
    });

    expect(result.success).toBe(true);
    expect(await watermarks.getScrapeWatermarks("profile-flag-off")).toEqual(
      new Map([
        ["jobspy", SCRAPE_STARTED_AT],
        ["apify:abc", SCRAPE_STARTED_AT],
      ]),
    );
  });

  it("records nothing when the run has no profile", async () => {
    const pipeline = await import("./orchestrator");
    const { db, schema } = await import("../db/index");

    await pipeline.runPipeline({ sources: [], scrapeSinceLastRun: true });

    // Counted across the whole table rather than looked up by profile id: a
    // profile-less run has no id to query, so asking for one (the previous
    // shape of this test) was satisfied whatever the code did.
    //
    // What this pins is the user-visible contract — no rows — not the guard
    // itself: removing the `profileId` check leaves the insert throwing on a
    // NOT NULL column, and `advanceScrapeWatermarks` swallows that into a warn,
    // so the table ends up empty either way. The guard makes the outcome
    // deliberate rather than exception-driven.
    const rows = await db.select().from(schema.sourceScrapeWatermarks);
    expect(rows).toEqual([]);
  });
});
