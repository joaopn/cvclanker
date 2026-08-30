// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateRunScheduleInput } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runProfileSequence = vi.fn().mockResolvedValue(undefined);
const tryBeginProfileSequence = vi.fn(() => true);
const endProfileSequence = vi.fn();
const setActiveRunTrigger = vi.fn();
const getPipelineStatus = vi.fn(() => ({ isRunning: false }));
const getProgress = vi.fn(() => ({
  step: "completed" as string,
  message: "Pipeline complete",
  detail: undefined as string | undefined,
  error: undefined as string | undefined,
}));

vi.mock("@server/pipeline/index", () => ({
  runProfileSequence: (entries: unknown, options: unknown) =>
    runProfileSequence(entries, options),
  tryBeginProfileSequence: () => tryBeginProfileSequence(),
  endProfileSequence: () => endProfileSequence(),
  getPipelineStatus: () => getPipelineStatus(),
  getProgress: () => getProgress(),
  // The barrel is whole-module mocked, so every export the service imports has
  // to be listed here or it throws on first ACCESS.
  setActiveRunTrigger: (trigger: unknown) => setActiveRunTrigger(trigger),
}));

const assembleRun = vi.fn();
vi.mock("@server/services/pipeline-run/assemble", () => ({
  assembleRun: (body: unknown, options: unknown) => assembleRun(body, options),
}));

const resolveDuplicatesForSchedule = vi.fn(async () => 3);
vi.mock("./resolve-duplicates", () => ({
  resolveDuplicatesForSchedule: () => resolveDuplicatesForSchedule(),
}));

const isRateLimitStopped = vi.fn(() => false);
const resetRateLimitBudget = vi.fn();
vi.mock("@server/services/llm/rate-limit-budget", () => ({
  isRateLimitStopped: () => isRateLimitStopped(),
  resetRateLimitBudget: (retries: unknown) => resetRateLimitBudget(retries),
}));

describe.sequential("scheduler pass", () => {
  let tempDir: string;
  let scheduler: Awaited<typeof import("./index")>;
  let repo: Awaited<typeof import("@server/repositories/run-schedules")>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // `clearAllMocks` resets calls, NOT implementations, so a test that swaps
    // one leaks into every test after it.
    runProfileSequence.mockResolvedValue(undefined);
    tryBeginProfileSequence.mockReturnValue(true);
    getPipelineStatus.mockReturnValue({ isRunning: false });
    getProgress.mockReturnValue({
      step: "completed",
      message: "Pipeline complete",
      detail: undefined,
      error: undefined,
    });
    isRateLimitStopped.mockReturnValue(false);
    resolveDuplicatesForSchedule.mockResolvedValue(3);
    assembleRun.mockResolvedValue({
      ok: true,
      kind: "sequence",
      entries: [{ profile: { id: "p1", name: "First" }, config: {} }],
      skippedProfiles: [],
      skippedDisabledSources: [],
    });

    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-scheduler-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("@server/db/migrate");
    repo = await import("@server/repositories/run-schedules");
    scheduler = await import("./index");
  });

  afterEach(async () => {
    const { closeDb } = await import("@server/db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  const dueSchedule = (
    overrides: Partial<CreateRunScheduleInput> = {},
  ): CreateRunScheduleInput => ({
    name: "Nightly",
    enabled: true,
    cadenceKind: "daily_at",
    intervalHours: null,
    timeOfDay: "06:00",
    daysOfWeek: null,
    profileIds: ["p1"],
    sourceMode: "profile",
    sources: null,
    providerInstanceIds: null,
    scrapeWindowDays: null,
    scrapeSinceLastRun: null,
    enableAutoTailoring: null,
    autoResolveDuplicates: false,
    nextFireAt: "2026-08-30T06:00:00.000Z",
    ...overrides,
  });

  const now = new Date("2026-08-30T06:00:30.000Z");

  it("fires a due schedule as a SCHEDULE-triggered chain", async () => {
    await repo.createRunSchedule(dueSchedule());

    expect(await scheduler.runSchedulerPass(now)).toMatchObject({
      acted: "fired",
    });
    // The trigger is what keeps a scheduled run out of the Manage banner.
    expect(runProfileSequence).toHaveBeenCalledWith(expect.any(Array), {
      trigger: "schedule",
    });
    // And it is established beside the CLAIM, not left to the sequence several
    // awaits later: `getPipelineStatus()` reports the partition from the moment
    // the claim makes the pipeline "running", reading a latch until then.
    expect(setActiveRunTrigger).toHaveBeenCalledWith("schedule");
  });

  it("advances the target past the fire so the same slot cannot repeat", async () => {
    const created = await repo.createRunSchedule(dueSchedule());
    await scheduler.runSchedulerPass(now);

    const after = await repo.getRunSchedule(created.id);
    expect(after?.lastStatus).toBe("success");
    expect(after?.nextFireAt).toBe("2026-08-31T06:00:00.000Z");
  });

  it("leaves a schedule that is not yet due alone", async () => {
    await repo.createRunSchedule(
      dueSchedule({ nextFireAt: "2026-08-31T06:00:00.000Z" }),
    );
    expect(await scheduler.runSchedulerPass(now)).toEqual({ acted: "none" });
    expect(runProfileSequence).not.toHaveBeenCalled();
  });

  it("never fires a schedule with no computed target", async () => {
    await repo.createRunSchedule(dueSchedule({ nextFireAt: null }));

    // A null target must not read as "due now": a schedule re-enabled after a
    // fortnight would otherwise fire the moment it is switched on, which on a
    // paid actor is unbudgeted spend from flipping a toggle.
    expect(await scheduler.runSchedulerPass(now)).toEqual({ acted: "none" });
    expect(runProfileSequence).not.toHaveBeenCalled();
  });

  it("never fires a disabled schedule", async () => {
    await repo.createRunSchedule(dueSchedule({ enabled: false }));
    expect(await scheduler.runSchedulerPass(now)).toEqual({ acted: "none" });
  });

  it("defers WITHOUT advancing the target when the pipeline is busy", async () => {
    const created = await repo.createRunSchedule(dueSchedule());
    getPipelineStatus.mockReturnValue({ isRunning: true });

    expect(await scheduler.runSchedulerPass(now)).toMatchObject({
      acted: "deferred",
    });
    // Deferring must not lose the run: it stays due, and goes as soon as the
    // pipeline is free.
    const after = await repo.getRunSchedule(created.id);
    expect(after?.nextFireAt).toBe("2026-08-30T06:00:00.000Z");
    expect(after?.lastStatus).toBeNull();
    expect(runProfileSequence).not.toHaveBeenCalled();
  });

  it("keeps the claim when the chain takes it over", async () => {
    await repo.createRunSchedule(dueSchedule());

    await scheduler.runSchedulerPass(now);

    // `runProfileSequence` releases the claim in its own `finally`. Releasing
    // it here too would hand the next caller a claim the chain still owns,
    // which is what keeps the User-Profile DB from being swapped mid-run.
    expect(endProfileSequence).not.toHaveBeenCalled();
  });

  it("records the chain as running, not as a result it has not produced", async () => {
    const created = await repo.createRunSchedule(dueSchedule());
    // A chain that never finishes, so the row is observed mid-run.
    runProfileSequence.mockReturnValue(new Promise(() => {}));

    await scheduler.runSchedulerPass(now);

    // Starting the chain says nothing about how it went: every per-profile
    // failure is COUNTED inside the sequence, not thrown, so a "success" here
    // would be a card claiming a result that may never arrive.
    expect((await repo.getRunSchedule(created.id))?.lastStatus).toBe("running");
  });

  it("replaces running with the chain's real outcome once it finishes", async () => {
    const created = await repo.createRunSchedule(dueSchedule());
    await scheduler.runSchedulerPass(now);
    await vi.waitFor(async () => {
      expect((await repo.getRunSchedule(created.id))?.lastStatus).toBe(
        "success",
      );
    });
  });

  it("pauses scheduling when the chain itself fails, not just its assembly", async () => {
    const created = await repo.createRunSchedule(dueSchedule());
    getProgress.mockReturnValue({
      step: "failed",
      message: "Pipeline failed",
      detail: undefined,
      error: "every profile failed",
    });

    await scheduler.runSchedulerPass(now);

    // Both inside the wait: the outcome and the pause are two awaits in the
    // detached observer, so asserting the second right after the first sees it
    // before it lands.
    await vi.waitFor(async () => {
      expect((await repo.getRunSchedule(created.id))?.lastStatus).toBe(
        "failed",
      );
      expect(await scheduler.isSchedulingPaused()).toMatch(
        /every profile failed/,
      );
    });
  });

  it("pauses on a rate limit, which the chain reports as completed", async () => {
    const created = await repo.createRunSchedule(dueSchedule());
    isRateLimitStopped.mockReturnValue(true);

    await scheduler.runSchedulerPass(now);

    // `summarize()` calls a partially-successful rate-limited chain
    // "completed", so the latch is the only honest signal — and an unnoticed
    // one means every later fire scrapes (billing per result) and classifies
    // nothing.
    await vi.waitFor(async () => {
      expect((await repo.getRunSchedule(created.id))?.lastStatus).toBe(
        "failed",
      );
      expect(await scheduler.isSchedulingPaused()).toMatch(/rate limit/i);
    });
  });

  it("does not send a window and the since-last-run flag together", async () => {
    await repo.createRunSchedule(
      dueSchedule({ scrapeWindowDays: 14, scrapeSinceLastRun: true }),
    );

    await scheduler.runSchedulerPass(now);

    // The run route refuses the combination as a contradiction, so sending
    // both would fail every fire of a schedule that stores both.
    const body = assembleRun.mock.calls[0][0];
    expect(body.scrapeWindowDays).toBe(14);
    expect("scrapeSinceLastRun" in body).toBe(false);
  });

  it("gives the sequence claim back when it defers on a lost race", async () => {
    await repo.createRunSchedule(dueSchedule());
    tryBeginProfileSequence.mockReturnValue(false);

    expect(await scheduler.runSchedulerPass(now)).toMatchObject({
      acted: "deferred",
    });
    // It never took the claim, so it must not release one either.
    expect(endProfileSequence).not.toHaveBeenCalled();
  });

  it("releases the claim when assembly fails, instead of stranding it", async () => {
    await repo.createRunSchedule(dueSchedule());
    assembleRun.mockResolvedValue({
      ok: false,
      error: { message: "No sources are enabled for this run." },
    });

    await scheduler.runSchedulerPass(now);

    // A stranded claim 409s every later run and the app believes a run is in
    // progress for ever.
    expect(endProfileSequence).toHaveBeenCalledTimes(1);
  });

  it("pauses all scheduling when a fire fails, and stops firing", async () => {
    const created = await repo.createRunSchedule(dueSchedule());
    assembleRun.mockResolvedValue({
      ok: false,
      error: { message: "No sources are enabled for this run." },
    });

    await scheduler.runSchedulerPass(now);

    const after = await repo.getRunSchedule(created.id);
    expect(after?.lastStatus).toBe("failed");
    expect(after?.lastDetail).toMatch(/No sources are enabled/);
    expect(await scheduler.isSchedulingPaused()).toMatch(/"Nightly" failed/);

    // The whole point of the pause: nothing else fires until a user clears it.
    assembleRun.mockResolvedValue({
      ok: true,
      kind: "sequence",
      entries: [{ profile: { id: "p1", name: "First" }, config: {} }],
      skippedProfiles: [],
      skippedDisabledSources: [],
    });
    runProfileSequence.mockClear();
    expect(
      await scheduler.runSchedulerPass(new Date("2026-08-31T06:00:30.000Z")),
    ).toEqual({ acted: "paused" });
    expect(runProfileSequence).not.toHaveBeenCalled();
  });

  it("resumes firing once the pause is cleared", async () => {
    await repo.createRunSchedule(dueSchedule());
    assembleRun.mockResolvedValueOnce({
      ok: false,
      error: { message: "boom" },
    });
    await scheduler.runSchedulerPass(now);

    await scheduler.resumeScheduling();
    expect(await scheduler.isSchedulingPaused()).toBeNull();

    // The failed fire advanced the target to the next day, so a pass on that
    // day fires again.
    expect(
      await scheduler.runSchedulerPass(new Date("2026-08-31T06:00:30.000Z")),
    ).toMatchObject({ acted: "fired" });
  });

  it("does not clear the rate-limit latch on a scheduled fire", async () => {
    await repo.createRunSchedule(dueSchedule());

    await scheduler.runSchedulerPass(now);

    // The run route clears it because a USER pressing Run is a signal the
    // limit may have passed. A timer is not — and a latched limit is itself
    // one of the things that pauses scheduling, so a tick that cleared it
    // every pass would defeat its own health check.
    expect(resetRateLimitBudget).not.toHaveBeenCalled();
  });

  it("asks for the schedule's sources rather than the profile's on free_only", async () => {
    await repo.createRunSchedule(dueSchedule({ sourceMode: "free_only" }));

    await scheduler.runSchedulerPass(now);

    const body = assembleRun.mock.calls[0][0];
    // An empty instance list is what EXCLUDES the paid actors; omitting it
    // would mean "every enabled instance", which is the opposite.
    expect(body.providerInstanceIds).toEqual([]);
    expect(Array.isArray(body.sources)).toBe(true);
    // And the run must tolerate a source disabled since the schedule was saved.
    expect(assembleRun.mock.calls[0][1]).toMatchObject({
      skipDisabledSources: true,
    });
  });

  it("sends no source scoping at all on the profile mode", async () => {
    await repo.createRunSchedule(dueSchedule({ sourceMode: "profile" }));
    await scheduler.runSchedulerPass(now);

    const body = assembleRun.mock.calls[0][0];
    // Each leg must run exactly its own pins; an empty list would mean "none".
    expect(body.sources).toBeUndefined();
    expect(body.providerInstanceIds).toBeUndefined();
  });

  it("omits a tri-state flag that is null rather than sending false", async () => {
    await repo.createRunSchedule(
      dueSchedule({ enableAutoTailoring: null, scrapeSinceLastRun: null }),
    );
    await scheduler.runSchedulerPass(now);

    const body = assembleRun.mock.calls[0][0];
    // Null means "follow the profile/setting"; sending false would override it.
    expect("enableAutoTailoring" in body).toBe(false);
    expect("scrapeSinceLastRun" in body).toBe(false);
  });

  it("sweeps duplicates after a completed chain when the schedule asks", async () => {
    const created = await repo.createRunSchedule(
      dueSchedule({ autoResolveDuplicates: true }),
    );

    await scheduler.runSchedulerPass(now);

    await vi.waitFor(async () => {
      expect(
        (await repo.getRunSchedule(created.id))?.lastDuplicatesClosed,
      ).toBe(3);
    });
  });

  it("does NOT sweep after a cancelled chain", async () => {
    const created = await repo.createRunSchedule(
      dueSchedule({ autoResolveDuplicates: true }),
    );
    getProgress.mockReturnValue({
      step: "cancelled",
      message: "Cancelled",
      detail: undefined,
      error: undefined,
    });

    await scheduler.runSchedulerPass(now);

    // A cancelled chain is exactly a run that died half-way — profiles never
    // started, sources never scraped — so its picture of what exists is
    // partial, and closing rows against it is irreversible.
    await vi.waitFor(async () => {
      expect((await repo.getRunSchedule(created.id))?.lastStatus).toBe(
        "skipped",
      );
    });
    expect(resolveDuplicatesForSchedule).not.toHaveBeenCalled();
  });

  it("does not sweep when the schedule did not ask", async () => {
    await repo.createRunSchedule(dueSchedule({ autoResolveDuplicates: false }));

    await scheduler.runSchedulerPass(now);
    await vi.waitFor(() => {
      expect(getProgress).toHaveBeenCalled();
    });

    expect(resolveDuplicatesForSchedule).not.toHaveBeenCalled();
  });

  it("fires only ONE schedule per pass", async () => {
    await repo.createRunSchedule(dueSchedule({ name: "A" }));
    await repo.createRunSchedule(dueSchedule({ name: "B" }));

    await scheduler.runSchedulerPass(now);

    // The pipeline is a singleton, so a second would bounce off its guard and
    // be recorded as a failure it never really had.
    expect(runProfileSequence).toHaveBeenCalledTimes(1);
  });
});
