import { badRequest, conflict, notFound } from "@infra/errors";
import { asyncRoute, ok } from "@infra/http";
import {
  endProfileSequence,
  getPipelineStatus,
  tryBeginProfileSequence,
} from "@server/pipeline/index";
import {
  createRunSchedule,
  deleteRunSchedule,
  getAllRunSchedules,
  getRunSchedule,
  recordRunScheduleOutcome,
  updateRunSchedule,
} from "@server/repositories/run-schedules";
import {
  computeNextFire,
  fireSchedule,
  isSchedulingPaused,
  resolveSchedulerTimeZone,
  resumeScheduling,
} from "@server/services/scheduler";
import {
  RUN_SCHEDULE_CADENCE_KINDS,
  RUN_SCHEDULE_SOURCE_MODES,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const schedulesRouter = Router();

/**
 * What a client may write.
 *
 * Deliberately excludes every server-managed field — `nextFireAt` and the
 * `last*` record. Zod strips unknown keys silently, so a client sending one
 * gets a 200 and no effect; that is the documented `updateJobSchema` trap, and
 * the answer there is the same as here: if a client ever needs to write one,
 * add it explicitly rather than discovering it works by accident.
 */
const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  cadenceKind: z.enum(RUN_SCHEDULE_CADENCE_KINDS),
  // Bounded at a year: beyond that the arithmetic leaves the range a Date can
  // hold, and `nextFireAt` would answer null for a schedule that looks saved.
  intervalHours: z.number().int().min(1).max(8760).nullable().default(null),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24-hour")
    .nullable()
    .default(null),
  // 0 = Sunday. An EMPTY array means "no day", which is a schedule that can
  // never fire — refused here rather than stored as a silent dead end.
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .nullable()
    .default(null),
  profileIds: z.array(z.string().min(1)).min(1),
  sourceMode: z.enum(RUN_SCHEDULE_SOURCE_MODES).default("profile"),
  sources: z.array(z.string().min(1)).nullable().default(null),
  providerInstanceIds: z.array(z.string().min(1)).nullable().default(null),
  scrapeWindowDays: z.number().int().min(1).max(365).nullable().default(null),
  scrapeSinceLastRun: z.boolean().nullable().default(null),
  enableAutoTailoring: z.boolean().nullable().default(null),
  autoResolveDuplicates: z.boolean().default(false),
});

/** A cadence must carry the parameter it runs on; the table CHECKs this too. */
function cadenceError(body: z.infer<typeof scheduleSchema>): string | null {
  if (body.cadenceKind === "every_n_hours" && body.intervalHours === null) {
    return "An every-N-hours schedule needs an interval.";
  }
  if (body.cadenceKind === "daily_at" && body.timeOfDay === null) {
    return "A daily schedule needs a time of day.";
  }
  return null;
}

schedulesRouter.get(
  "/",
  asyncRoute(async (_req: Request, res: Response) => {
    const [schedules, pausedReason, timeZone] = await Promise.all([
      getAllRunSchedules(),
      isSchedulingPaused(),
      resolveSchedulerTimeZone(),
    ]);
    ok(res, { schedules, pausedReason, timeZone });
  }),
);

schedulesRouter.post(
  "/",
  asyncRoute(async (req: Request, res: Response) => {
    const body = scheduleSchema.parse(req.body ?? {});
    const invalid = cadenceError(body);
    if (invalid) throw badRequest(invalid);

    const created = await createRunSchedule(body);
    // The first target is computed HERE rather than left null, or the schedule
    // is saved looking armed and never becomes due.
    const next = created.enabled
      ? await computeNextFire(created, new Date())
      : null;
    const armed = await updateRunSchedule(created.id, {
      nextFireAt: next?.toISOString() ?? null,
    });
    ok(res, armed ?? created);
  }),
);

schedulesRouter.put(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const existing = await getRunSchedule(req.params.id);
    if (!existing) throw notFound("Schedule not found");

    const body = scheduleSchema.parse(req.body ?? {});
    const invalid = cadenceError(body);
    if (invalid) throw badRequest(invalid);

    const updated = await updateRunSchedule(req.params.id, body);
    if (!updated) throw notFound("Schedule not found");
    // Recomputed on EVERY save, not just a cadence change: re-enabling a
    // schedule that has been off for a fortnight must not fire it the instant
    // the toggle flips, which on a paid actor is unbudgeted spend.
    const next = updated.enabled
      ? await computeNextFire(updated, new Date())
      : null;
    const armed = await updateRunSchedule(req.params.id, {
      nextFireAt: next?.toISOString() ?? null,
    });
    ok(res, armed ?? updated);
  }),
);

schedulesRouter.delete(
  "/:id",
  asyncRoute(async (req: Request, res: Response) => {
    const existing = await getRunSchedule(req.params.id);
    if (!existing) throw notFound("Schedule not found");
    await deleteRunSchedule(req.params.id);
    ok(res, { deleted: true });
  }),
);

/**
 * Fire a schedule now, by hand.
 *
 * Goes through the same `fireSchedule` the tick uses — the point of the
 * assembly extraction is one derivation of what a run does, not one per entry
 * point. It does NOT advance `next_fire_at`: this is an extra run, not this
 * schedule's scheduled one.
 */
schedulesRouter.post(
  "/:id/run-now",
  asyncRoute(async (req: Request, res: Response) => {
    const schedule = await getRunSchedule(req.params.id);
    if (!schedule) throw notFound("Schedule not found");
    if (getPipelineStatus().isRunning) {
      throw conflict("A pipeline run is already in progress. Cancel it first.");
    }
    // Claimed HERE, synchronously before the first await, exactly as
    // `POST /pipeline/run` does. `runProfileSequence` releases the claim in its
    // own `finally`, so starting a chain without one leaves
    // `isProfileSequenceActive()` false for the whole run — which is what stops
    // the User-Profile DB being swapped underneath it — and then releases a
    // claim someone else may have taken. Two presses would otherwise both pass
    // the `isRunning` read above and both start.
    if (!tryBeginProfileSequence()) {
      throw conflict("A multi-profile run is already in progress");
    }

    let handedOff = false;
    try {
      const outcome = await fireSchedule(schedule);
      handedOff = outcome.status === "success";
      await recordRunScheduleOutcome(schedule.id, {
        // "running" until the chain finishes; the scheduler's own observer
        // replaces it with what actually happened.
        status: handedOff ? "running" : "failed",
        detail: outcome.detail,
      });
      if (!handedOff) {
        throw badRequest(outcome.detail ?? "The schedule could not be run");
      }
      ok(res, {
        started: true,
        skippedProfiles: outcome.skippedProfiles ?? [],
      });
    } finally {
      // Ownership passes to the sequence, which releases it itself. Every other
      // exit — including the throw above — must give it back, or every later
      // run 409s and the app believes a run is in progress for ever.
      if (!handedOff) endProfileSequence();
    }
  }),
);

/** Clear the pause a failed scheduled run raised, so automatic runs resume. */
schedulesRouter.post(
  "/resume",
  asyncRoute(async (_req: Request, res: Response) => {
    await resumeScheduling();
    ok(res, { pausedReason: null });
  }),
);
