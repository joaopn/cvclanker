// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Four bulk/automatic operations used to infer "this row was never applied to"
 * from its STATUS, and that inference was sound only because nothing could move
 * an applied row onto a shelf or back into triage. The stage switcher moves any
 * row to any stage, so each now reads `applied_at` — the permanent mark — and
 * these tests are what hold that shut.
 *
 * Every case is a row carrying the mark at a status the operation WOULD
 * otherwise act on. Each has a twin without the mark, so a guard widened into
 * "never touch this status" fails too.
 */
describe.sequential("applied-mark guards on bulk and automatic sweeps", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-applied-guards-"));
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

  const APPLIED_AT = "2026-04-02T00:00:00.000Z";

  const insert = (args: {
    id: string;
    status:
      | "discovered"
      | "selected"
      | "backlog"
      | "stale"
      | "ready"
      | "applied"
      | "skipped"
      | "closed";
    appliedAt?: string | null;
    liveClosed?: boolean | null;
    suitabilityCategory?:
      | "great_fit"
      | "very_good_fit"
      | "good_fit"
      | "bad_fit";
  }) =>
    db.insert(schema.jobs).values({
      id: args.id,
      source: "linkedin",
      title: "Backend Engineer",
      employer: "Acme",
      jobUrl: `https://example.com/${args.id}`,
      status: args.status,
      appliedAt: args.appliedAt ?? null,
      liveClosed: args.liveClosed ?? null,
      suitabilityCategory: args.suitabilityCategory ?? null,
    });

  const statusOf = async (id: string) =>
    (await jobsRepo.getJobById(id))?.status ?? null;

  const age = async (ids: string[]) => {
    const { sql, inArray } = await import("drizzle-orm");
    await db
      .update(schema.jobs)
      .set({ discoveredAt: sql`datetime('now', '-30 days')` })
      .where(inArray(schema.jobs.id, ids));
  };

  it("age sweep leaves an aged shelf row that was applied to", async () => {
    await insert({
      id: "aged-applied",
      status: "backlog",
      appliedAt: APPLIED_AT,
    });
    await insert({ id: "aged-plain", status: "backlog" });
    await age(["aged-applied", "aged-plain"]);

    const result = await jobsRepo.sweepStaleJobs(14);

    expect(result.moved).toBe(1);
    expect(await statusOf("aged-applied")).toBe("backlog");
    expect(await statusOf("aged-plain")).toBe("stale");
  });

  /**
   * This sweep has NO age test, and `live_closed` is the normal state of a
   * posting you already applied to — so an applied row parked on a shelf would
   * be swept the moment the next live-status check ran.
   */
  it("closed-posting sweep leaves a shelf row that was applied to", async () => {
    await insert({
      id: "lc-applied",
      status: "discovered",
      appliedAt: APPLIED_AT,
      liveClosed: true,
    });
    await insert({ id: "lc-plain", status: "discovered", liveClosed: true });

    const result = await jobsRepo.sweepLiveClosedJobs();

    expect(result.moved).toBe(1);
    expect(await statusOf("lc-applied")).toBe("discovered");
    expect(await statusOf("lc-plain")).toBe("stale");
  });

  /**
   * The deliberate NON-guard, pinned so nobody "fixes" it into consistency
   * with its neighbours. `deleteJobsByStatus` is TARGETED: Settings → Danger
   * Zone has the user tick the exact statuses and confirm a dialog naming
   * them, `applied` and `in_progress` among the boxes on offer. A mark guard
   * here would silently keep rows the user explicitly named, report a count
   * that did not match, and leave no way to purge an application at all. The
   * guards in this file exist because those operations INFER which rows are
   * expendable; this one is told.
   */
  it("delete-by-status deletes a row that was applied to, because it was named", async () => {
    await insert({
      id: "del-applied",
      status: "skipped",
      appliedAt: APPLIED_AT,
    });
    await insert({ id: "del-plain", status: "skipped" });

    const deleted = await jobsRepo.deleteJobsByStatus("skipped");

    expect(deleted).toBe(2);
    expect(await statusOf("del-applied")).toBeNull();
    expect(await statusOf("del-plain")).toBeNull();
  });

  it("delete-by-category keeps a row that was applied to", async () => {
    await insert({
      id: "cat-applied",
      status: "closed",
      appliedAt: APPLIED_AT,
      suitabilityCategory: "bad_fit",
    });
    await insert({
      id: "cat-plain",
      status: "closed",
      suitabilityCategory: "bad_fit",
    });

    const deleted = await jobsRepo.deleteJobsByCategory(["bad_fit"]);

    expect(deleted).toBe(1);
    expect(await statusOf("cat-applied")).toBe("closed");
    expect(await statusOf("cat-plain")).toBeNull();
  });

  // The pre-existing status guard must survive the new one: a live application
  // is protected whether or not the mark was ever written (a legacy row the
  // boot backfill found no usable timestamp for has status but no mark).
  it("delete-by-category still keeps an unmarked live row", async () => {
    await insert({
      id: "cat-live",
      status: "applied",
      appliedAt: null,
      suitabilityCategory: "bad_fit",
    });

    expect(await jobsRepo.deleteJobsByCategory(["bad_fit"])).toBe(0);
    expect(await statusOf("cat-live")).toBe("applied");
  });
});
