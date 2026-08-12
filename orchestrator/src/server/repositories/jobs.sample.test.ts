// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStatus, SuitabilityCategory } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LONG_ENOUGH = "x".repeat(200);

describe.sequential("getRandomScoreableJobs", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jobs-sample-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
    ({ db, schema } = await import("../db/index"));
    jobsRepo = await import("./jobs");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const insert = (
    id: string,
    overrides: {
      status?: JobStatus;
      jobDescription?: string | null;
      suitabilityCategory?: SuitabilityCategory | null;
    } = {},
  ) =>
    db.insert(schema.jobs).values({
      id,
      source: "linkedin",
      title: `Job ${id}`,
      employer: "Acme",
      jobUrl: `https://example.com/jobs/${id}`,
      status: overrides.status ?? "discovered",
      jobDescription:
        overrides.jobDescription === undefined
          ? LONG_ENOUGH
          : overrides.jobDescription,
      suitabilityCategory: overrides.suitabilityCategory ?? null,
    });

  const sample = (
    args: Parameters<typeof jobsRepo.getRandomScoreableJobs>[0],
  ) => jobsRepo.getRandomScoreableJobs(args);

  it("skips closed jobs and descriptions too short to judge", async () => {
    await insert("keep");
    await insert("closed", { status: "closed" });
    await insert("short", { jobDescription: "too short" });
    await insert("empty", { jobDescription: null });

    const drawn = await sample({ limit: 10, minDescriptionChars: 100 });

    expect(drawn.map((job) => job.id)).toEqual(["keep"]);
  });

  it("counts a description's length the way the scorer does, ignoring surrounding newlines", async () => {
    // SQLite's one-argument trim() strips spaces only. Without the explicit
    // whitespace set this row is 106 chars to SQL and 98 to the scorer, so it
    // would be sampled and then rejected as unscoreable on every config.
    await insert("padded", {
      jobDescription: `\n\n\n\t${"x".repeat(98)}\r\n\n`,
    });

    const drawn = await sample({ limit: 10, minDescriptionChars: 100 });

    expect(drawn).toEqual([]);
  });

  it("draws only the requested categories", async () => {
    await insert("great", { suitabilityCategory: "great_fit" });
    await insert("bad", { suitabilityCategory: "bad_fit" });
    await insert("none");

    const drawn = await sample({
      limit: 10,
      minDescriptionChars: 100,
      categories: ["great_fit"],
    });

    expect(drawn.map((job) => job.id)).toEqual(["great"]);
  });

  it("treats 'unscored' as a category of its own", async () => {
    // `suitability_category IN (...)` is never true for NULL, so asking for
    // unscored jobs has to be an IS NULL test or it silently returns nothing.
    await insert("great", { suitabilityCategory: "great_fit" });
    await insert("none");

    const drawn = await sample({
      limit: 10,
      minDescriptionChars: 100,
      categories: ["unscored"],
    });

    expect(drawn.map((job) => job.id)).toEqual(["none"]);
  });

  it("combines scored and unscored selections", async () => {
    await insert("great", { suitabilityCategory: "great_fit" });
    await insert("bad", { suitabilityCategory: "bad_fit" });
    await insert("none");

    const drawn = await sample({
      limit: 10,
      minDescriptionChars: 100,
      categories: ["bad_fit", "unscored"],
    });

    expect(drawn.map((job) => job.id).sort()).toEqual(["bad", "none"]);
  });

  it("returns nothing for an empty selection rather than everything", async () => {
    await insert("great", { suitabilityCategory: "great_fit" });

    expect(
      await sample({ limit: 10, minDescriptionChars: 100, categories: [] }),
    ).toEqual([]);
  });

  it("never returns more than the limit", async () => {
    for (let index = 0; index < 8; index += 1) {
      await insert(`job-${index}`);
    }

    const drawn = await sample({ limit: 3, minDescriptionChars: 100 });

    expect(drawn).toHaveLength(3);
    expect(new Set(drawn.map((job) => job.id)).size).toBe(3);
  });
});
