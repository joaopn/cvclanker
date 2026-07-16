// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type JobStatusLiteral =
  | "discovered"
  | "processing"
  | "ready"
  | "applied"
  | "skipped"
  | "closed";

describe.sequential("getJobListItems employer filter", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jobs-company-"));
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
    title: string,
    employer: string,
    status: JobStatusLiteral,
  ) =>
    db.insert(schema.jobs).values({
      id,
      source: "linkedin",
      title,
      employer,
      jobUrl: `https://example.com/jobs/${id}`,
      status,
    });

  it("returns every status for the company, matched case-insensitively", async () => {
    await insert("a1", "Senior Eng", "Acme Corp", "discovered");
    await insert("a2", "Backend Eng", "acme corp", "closed");
    await insert("a3", "Data Eng", "ACME CORP", "skipped");
    await insert("z1", "Other role", "Globex", "ready");

    const items = await jobsRepo.getJobListItems(undefined, "acme corp");
    expect(items.map((j) => j.id).sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("returns an empty list for an unknown company", async () => {
    await insert("a1", "Senior Eng", "Acme Corp", "discovered");
    const items = await jobsRepo.getJobListItems(undefined, "Nope Inc");
    expect(items).toEqual([]);
  });

  it("ANDs the employer filter with a status filter when both are given", async () => {
    await insert("a1", "Senior Eng", "Acme Corp", "discovered");
    await insert("a2", "Backend Eng", "Acme Corp", "closed");

    const items = await jobsRepo.getJobListItems(["closed"], "Acme Corp");
    expect(items.map((j) => j.id)).toEqual(["a2"]);
  });
});
