// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type JobStatusLiteral =
  | "discovered"
  | "selected"
  | "processing"
  | "ready"
  | "backlog"
  | "stale"
  | "skipped"
  | "closed";

describe.sequential("jobs repository duplicate groups", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jobs-dups-"));
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
    source = "linkedin",
  ) =>
    db.insert(schema.jobs).values({
      id,
      source,
      title,
      employer,
      jobUrl: `https://example.com/jobs/${id}`,
      status,
    });

  it("groups active-triage jobs sharing a normalized title + company", async () => {
    await insert("a1", "Senior Data Engineer", "Acme Corp", "discovered");
    await insert("a2", "senior   data engineer", "ACME corp", "selected", "indeed");
    await insert("a3", "Sr. Data Engineer", "Acme Corp", "ready"); // different (Sr != Senior)

    const groups = await jobsRepo.getDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jobs.map((j) => j.id).sort()).toEqual(["a1", "a2"]);
  });

  it("excludes singletons and out-of-scope statuses", async () => {
    // A pair where one member is out of scope (closed) → no group.
    await insert("b1", "Backend Engineer", "Globex", "discovered");
    await insert("b2", "Backend Engineer", "Globex", "closed");
    // A lone active job → no group.
    await insert("b3", "Platform Engineer", "Globex", "selected");

    const groups = await jobsRepo.getDuplicateGroups();
    expect(groups).toHaveLength(0);
  });

  it("orders the largest clusters first", async () => {
    await insert("c1", "QA Engineer", "Initech", "discovered");
    await insert("c2", "QA Engineer", "Initech", "selected");
    await insert("d1", "DevOps Engineer", "Initech", "discovered");
    await insert("d2", "DevOps Engineer", "Initech", "ready");
    await insert("d3", "DevOps Engineer", "Initech", "processing");

    const groups = await jobsRepo.getDuplicateGroups();
    expect(groups).toHaveLength(2);
    expect(groups[0].jobs).toHaveLength(3);
    expect(groups[1].jobs).toHaveLength(2);
  });
});
