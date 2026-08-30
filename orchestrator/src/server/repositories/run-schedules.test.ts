// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateRunScheduleInput } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs the real migration against a throwaway DATA_DIR, so this also proves the
// new table and its CHECK constraints survive migrate on a fresh DB.
describe.sequential("run schedules repository", () => {
  let tempDir: string;
  let repo: Awaited<typeof import("./run-schedules")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-run-schedules-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
    repo = await import("./run-schedules");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const daily = (
    overrides: Partial<CreateRunScheduleInput> = {},
  ): CreateRunScheduleInput => ({
    name: "Nightly free scrape",
    enabled: true,
    cadenceKind: "daily_at",
    intervalHours: null,
    timeOfDay: "06:00",
    daysOfWeek: null,
    profileIds: ["profile-a", "profile-b"],
    sourceMode: "free_only",
    sources: null,
    providerInstanceIds: null,
    scrapeWindowDays: null,
    scrapeSinceLastRun: true,
    enableAutoTailoring: null,
    autoResolveDuplicates: false,
    ...overrides,
  });

  it("round-trips every field, including the three nullable flags", async () => {
    const created = await repo.createRunSchedule(
      daily({
        daysOfWeek: [1, 3, 5],
        sourceMode: "custom",
        sources: ["linkedin"],
        providerInstanceIds: ["instance-1"],
        scrapeWindowDays: 14,
        enableAutoTailoring: true,
        autoResolveDuplicates: true,
        nextFireAt: "2026-08-31T06:00:00.000Z",
      }),
    );

    const read = await repo.getRunSchedule(created.id);
    expect(read).toEqual(created);
    // SQLite has no boolean, so these are 0/1 columns — the three that are
    // NULLABLE are the ones a naive mapper turns into `false`.
    expect(read?.enableAutoTailoring).toBe(true);
    expect(read?.scrapeSinceLastRun).toBe(true);
    expect(read?.autoResolveDuplicates).toBe(true);
    expect(read?.daysOfWeek).toEqual([1, 3, 5]);
    expect(read?.profileIds).toEqual(["profile-a", "profile-b"]);
  });

  it("keeps a null tri-state flag null rather than collapsing it to false", async () => {
    const created = await repo.createRunSchedule(
      daily({ enableAutoTailoring: null, scrapeSinceLastRun: null }),
    );
    const read = await repo.getRunSchedule(created.id);

    // Null means "follow the app setting"; false means "explicitly off". A
    // mapper that conflates them silently changes what a run does.
    expect(read?.enableAutoTailoring).toBeNull();
    expect(read?.scrapeSinceLastRun).toBeNull();
  });

  it("does not throw when a stored JSON column is corrupt", async () => {
    const created = await repo.createRunSchedule(daily());
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.runSchedules)
      .set({ profileIds: "not json at all", daysOfWeek: "{}" })
      .where(eq(schema.runSchedules.id, created.id));

    // A restored snapshot or a hand-edited DB can hold anything; a read path
    // that throws takes the whole list down with it.
    const read = await repo.getRunSchedule(created.id);
    expect(read?.profileIds).toEqual([]);
    expect(read?.daysOfWeek).toBeNull();
    await expect(repo.getAllRunSchedules()).resolves.toHaveLength(1);
  });

  it("keeps an empty weekday mask empty instead of reading it as every day", async () => {
    const created = await repo.createRunSchedule(daily({ daysOfWeek: [] }));
    const read = await repo.getRunSchedule(created.id);

    // null means every day and [] means no day. Folding one into the other
    // turns a user who unticked every weekday into a schedule that runs daily.
    expect(read?.daysOfWeek).toEqual([]);
  });

  it("normalises a next fire written with an offset into UTC", async () => {
    const created = await repo.createRunSchedule(
      daily({ nextFireAt: "2026-08-31T08:00:00+02:00" }),
    );
    const read = await repo.getRunSchedule(created.id);

    // The column is ordered AND compared as text, and SQLite compares text
    // lexically — one offset-bearing write would break both silently.
    expect(read?.nextFireAt).toBe("2026-08-31T06:00:00.000Z");
  });

  it("stores timestamps as ISO, not SQLite's space-separated default", async () => {
    const created = await repo.createRunSchedule(daily());

    // `created_at` is the phase anchor for an every-N-hours cadence, and
    // `new Date("2026-08-30 12:22:33")` is parsed in the HOST zone.
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("reports an unrecognised stored status as none rather than passing it on", async () => {
    const created = await repo.createRunSchedule(daily());
    const { db, schema } = await import("../db/index");
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.runSchedules)
      .set({ lastStatus: "exploded" })
      .where(eq(schema.runSchedules.id, created.id));

    // The column has no CHECK, so a hand-edited row could otherwise hand a
    // client's exhaustive switch a literal outside the union.
    expect((await repo.getRunSchedule(created.id))?.lastStatus).toBeNull();
  });

  it("refuses a cadence stored without the parameter it needs", async () => {
    const { db, schema } = await import("../db/index");

    await expect(
      db.insert(schema.runSchedules).values({
        id: "hours-without-interval",
        name: "x",
        cadenceKind: "every_n_hours",
        profileIds: "[]",
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(schema.runSchedules).values({
        id: "daily-without-time",
        name: "x",
        cadenceKind: "daily_at",
        profileIds: "[]",
      }),
    ).rejects.toThrow();
  });

  it("orders by the next fire, with never-computed schedules first", async () => {
    await repo.createRunSchedule(
      daily({ name: "later", nextFireAt: "2026-09-02T06:00:00.000Z" }),
    );
    await repo.createRunSchedule(
      daily({ name: "sooner", nextFireAt: "2026-09-01T06:00:00.000Z" }),
    );
    await repo.createRunSchedule(daily({ name: "unscheduled" }));

    // SQLite sorts NULLs first, and that is wanted: a schedule with no target
    // cannot become due until something computes one, so it leads the list.
    expect((await repo.getAllRunSchedules()).map((row) => row.name)).toEqual([
      "unscheduled",
      "sooner",
      "later",
    ]);
  });

  it("updates only the fields it is given", async () => {
    const created = await repo.createRunSchedule(daily());

    const updated = await repo.updateRunSchedule(created.id, {
      name: "Renamed",
      daysOfWeek: [0, 6],
    });

    expect(updated?.name).toBe("Renamed");
    expect(updated?.daysOfWeek).toEqual([0, 6]);
    expect(updated?.profileIds).toEqual(["profile-a", "profile-b"]);
    expect(updated?.timeOfDay).toBe("06:00");
  });

  it("records a fire and the target that follows it", async () => {
    const created = await repo.createRunSchedule(daily());

    await repo.recordRunScheduleFire(created.id, {
      firedAt: new Date("2026-08-30T06:00:01.000Z"),
      status: "success",
      runId: "run-1",
      duplicatesClosed: 4,
      nextFireAt: new Date("2026-08-31T06:00:00.000Z"),
    });

    const read = await repo.getRunSchedule(created.id);
    expect(read?.lastStatus).toBe("success");
    expect(read?.lastRunId).toBe("run-1");
    expect(read?.lastDuplicatesClosed).toBe(4);
    // ISO-8601 UTC, because the column is ordered AND compared as text.
    expect(read?.nextFireAt).toBe("2026-08-31T06:00:00.000Z");
    expect(read?.lastFiredAt).toBe("2026-08-30T06:00:01.000Z");
  });

  it("refuses a cadence or interval the scheduler could not act on", async () => {
    const { db, schema } = await import("../db/index");

    // CHECK constraints, not repo validation: SQLite cannot add one by ALTER,
    // so getting them wrong costs a table rebuild later.
    await expect(
      db.insert(schema.runSchedules).values({
        id: "bad-cadence",
        name: "x",
        cadenceKind: "hourly" as never,
        timeOfDay: "06:00",
        profileIds: "[]",
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(schema.runSchedules).values({
        id: "bad-interval",
        name: "x",
        cadenceKind: "every_n_hours",
        // A non-positive interval is a non-terminating slot search inside the
        // tick's setInterval.
        intervalHours: 0,
        profileIds: "[]",
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(schema.runSchedules).values({
        id: "bad-source-mode",
        name: "x",
        cadenceKind: "daily_at",
        timeOfDay: "06:00",
        sourceMode: "everything" as never,
        profileIds: "[]",
      }),
    ).rejects.toThrow();
  });

  it("deletes", async () => {
    const created = await repo.createRunSchedule(daily());
    await repo.deleteRunSchedule(created.id);
    expect(await repo.getRunSchedule(created.id)).toBeNull();
  });
});
