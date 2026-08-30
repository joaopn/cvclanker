// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStatus, UpdateJobInput } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `applied_at` is the permanent "this was applied to" mark — the one thing that
 * separates a closed row the user applied to from one they never did.
 *
 * These tests cover `updateJob`, which is the only writer. Note what that does
 * NOT prove: `updateJob` also has a pass-through branch for an explicit
 * `appliedAt`, which bypasses the coalesce entirely, and `POST /:id/apply` used
 * to take it — so the stickiness asserted here held in the repo while the
 * primary "Mark applied" path overwrote. That is pinned separately, at the
 * route, in `api/routes/jobs.apply.test.ts`. The explicit branch is now
 * caller-less and is the only way to move the mark.
 */
describe.sequential("updateJob applied_at stamping", () => {
  let tempDir: string;
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-applied-stamp-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    jobsRepo = await import("./jobs");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const seed = async (url: string): Promise<string> => {
    await jobsRepo.createJobs([
      {
        source: "linkedin",
        title: "T",
        employer: "E",
        jobUrl: url,
        datePosted: "2026-04-01T00:00:00.000Z",
      },
    ]);
    const job = await jobsRepo.getJobByUrl(url);
    if (!job) throw new Error(`seed failed for ${url}`);
    return job.id;
  };

  const move = async (id: string, patch: UpdateJobInput) =>
    jobsRepo.updateJob(id, patch);

  it("stamps on the applied transition", async () => {
    const id = await seed("https://ex/applied");
    expect((await jobsRepo.getJobById(id))?.appliedAt).toBeNull();

    const updated = await move(id, { status: "applied" });

    expect(updated?.appliedAt).toEqual(expect.any(String));
  });

  /**
   * The hole this test exists for: `JobStageSwitcher` offers `ready ->
   * in_progress` directly, so a job can reach Interviewing without ever passing
   * through `applied`. Closing it then produced `closed` + an outcome + a NULL
   * `applied_at` — a row that reads as never-applied when it definitively was.
   */
  it("stamps on a ready -> in_progress move that skips applied entirely", async () => {
    const id = await seed("https://ex/skips-applied");
    await move(id, { status: "ready" });
    expect((await jobsRepo.getJobById(id))?.appliedAt).toBeNull();

    const updated = await move(id, { status: "in_progress" });

    expect(updated?.appliedAt).toEqual(expect.any(String));
  });

  /**
   * The coalesce. An `applied -> in_progress` move must keep the ORIGINAL apply
   * date — the date the user applied, not the date they started interviewing.
   * Mutation check: dropping the `coalesce(...)` makes this fail.
   */
  it("keeps the first apply date when applied -> in_progress restamps", async () => {
    const id = await seed("https://ex/coalesce");
    const first = await move(id, { status: "applied" });
    const firstStamp = first?.appliedAt;
    expect(firstStamp).toEqual(expect.any(String));

    // Guarantee a distinct `new Date().toISOString()` on the second write.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await move(id, { status: "in_progress" });

    expect(second?.appliedAt).toBe(firstStamp);
  });

  /** Same stickiness on the way back down: a stage switch away keeps the mark. */
  it("keeps the mark when the job moves back out of applied", async () => {
    const id = await seed("https://ex/back-to-ready");
    const applied = await move(id, { status: "applied" });
    const stamp = applied?.appliedAt;

    const back = await move(id, { status: "ready" });

    expect(back?.appliedAt).toBe(stamp);
  });

  /**
   * Closing out — the whole point of the mark. A closed row keeps the evidence
   * that it was applied to, so rejections stay countable.
   */
  it("survives being closed with an outcome", async () => {
    const id = await seed("https://ex/closed");
    const applied = await move(id, { status: "applied" });
    const stamp = applied?.appliedAt;

    const closed = await move(id, {
      status: "closed",
      outcome: "rejected",
      closedAt: 1786711161,
    });

    expect(closed?.status).toBe("closed");
    expect(closed?.appliedAt).toBe(stamp);
  });

  /**
   * `reopen` nulls `outcome` and `closedAt` but must NOT null the apply mark —
   * the job WAS applied to, whatever shelf it sits on now.
   */
  it("survives a reopen back to discovered", async () => {
    const id = await seed("https://ex/reopened");
    const applied = await move(id, { status: "applied" });
    const stamp = applied?.appliedAt;

    const reopened = await move(id, {
      status: "discovered",
      outcome: null,
      closedAt: null,
    });

    expect(reopened?.outcome).toBeNull();
    expect(reopened?.appliedAt).toBe(stamp);
  });

  /** No other status stamps: a never-applied row must stay unmarked. */
  it.each<JobStatus>([
    "discovered",
    "processing",
    "ready",
    "backlog",
    "stale",
    "skipped",
  ])("does not stamp on a %s transition", async (status) => {
    const id = await seed(`https://ex/no-stamp-${status}`);

    const updated = await move(id, { status });

    expect(updated?.appliedAt).toBeNull();
  });

  /** A closure with no apply behind it stays unmarked — the case the mark exists to isolate. */
  it("leaves a skipped-then-closed row unmarked", async () => {
    const id = await seed("https://ex/never-applied");
    await move(id, { status: "skipped" });
    const closed = await move(id, {
      status: "closed",
      outcome: "duplicated",
      closedAt: 1786711161,
    });

    expect(closed?.appliedAt).toBeNull();
  });
});
