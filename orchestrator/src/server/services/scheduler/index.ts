import { logger } from "@infra/logger";
import { getExtractorRegistry } from "@server/extractors/registry";
import {
  endProfileSequence,
  getPipelineStatus,
  runProfileSequence,
  tryBeginProfileSequence,
} from "@server/pipeline/index";
import {
  getAllRunSchedules,
  getRunSchedule,
  recordRunScheduleFire,
  updateRunSchedule,
} from "@server/repositories/run-schedules";
import { setSetting } from "@server/repositories/settings";
import { getEnabledExtractorIds } from "@server/repositories/source-configs";
import { isRateLimitStopped } from "@server/services/llm/rate-limit-budget";
import {
  assembleRun,
  type RunBody,
} from "@server/services/pipeline-run/assemble";
import { getEffectiveSettings } from "@server/services/settings";
import type { RunSchedule } from "@shared/types";
import { type Cadence, nextFireAt } from "./next-fire";

/**
 * The scheduler: fires run schedules when they come due.
 *
 * One pass does at most ONE schedule, because the pipeline is a process-wide
 * singleton — a second would bounce off the same guard and be recorded as a
 * failure it never really had.
 */

/** Fallback when no `schedulerTimeZone` is stored. */
const DEFAULT_TIME_ZONE = "UTC";

function cadenceOf(schedule: RunSchedule): Cadence {
  return schedule.cadenceKind === "every_n_hours"
    ? {
        kind: "every_n_hours",
        intervalHours: schedule.intervalHours ?? 0,
        daysOfWeek: schedule.daysOfWeek,
      }
    : {
        kind: "daily_at",
        timeOfDay: schedule.timeOfDay ?? "",
        daysOfWeek: schedule.daysOfWeek,
      };
}

export async function resolveSchedulerTimeZone(): Promise<string> {
  const settings = await getEffectiveSettings();
  return settings.schedulerTimeZone ?? DEFAULT_TIME_ZONE;
}

/**
 * The next fire for a schedule, from `now`.
 *
 * Exported because creating or ENABLING a schedule has to compute one too: a
 * null target never becomes due, and a target left over from before a
 * fortnight's pause would fire the instant the toggle flips.
 */
export async function computeNextFire(
  schedule: RunSchedule,
  from: Date,
): Promise<Date | null> {
  return nextFireAt(cadenceOf(schedule), {
    from,
    timeZone: await resolveSchedulerTimeZone(),
    anchor: new Date(schedule.createdAt),
  });
}

/**
 * Turn a schedule's stored source rule into the run request's source scoping.
 *
 * `free_only` resolves against what is enabled AT FIRE TIME rather than a
 * stored list, so a board added months later is picked up without editing the
 * schedule — and one disabled since cannot fail the run.
 */
async function resolveSources(
  schedule: RunSchedule,
): Promise<Pick<RunBody, "sources" | "providerInstanceIds">> {
  if (schedule.sourceMode === "profile") {
    // No lists at all: each leg runs exactly its own pins.
    return {};
  }
  if (schedule.sourceMode === "free_only") {
    const [registry, enabledIds] = await Promise.all([
      getExtractorRegistry(),
      getEnabledExtractorIds(),
    ]);
    const enabled = new Set(enabledIds);
    const sources = [...registry.manifestBySource.entries()]
      .filter(([, manifest]) => enabled.has(manifest.id))
      .map(([platform]) => platform);
    // An empty instance list is what excludes the paid actors; omitting it
    // would mean "all enabled instances", which is the opposite.
    return { sources: sources as RunBody["sources"], providerInstanceIds: [] };
  }
  return {
    sources: (schedule.sources ?? []) as RunBody["sources"],
    providerInstanceIds: schedule.providerInstanceIds ?? [],
  };
}

function buildRunBody(
  schedule: RunSchedule,
  sources: Pick<RunBody, "sources" | "providerInstanceIds">,
): RunBody {
  return {
    profileIds: schedule.profileIds,
    ...sources,
    ...(schedule.scrapeWindowDays !== null
      ? { scrapeWindowDays: schedule.scrapeWindowDays }
      : {}),
    // Only sent when the schedule says so: an explicit `false` would override
    // the Profile's own flag, which is not what "follow the profile" means.
    ...(schedule.scrapeSinceLastRun !== null &&
    schedule.scrapeWindowDays === null
      ? { scrapeSinceLastRun: schedule.scrapeSinceLastRun }
      : {}),
    ...(schedule.enableAutoTailoring !== null
      ? { enableAutoTailoring: schedule.enableAutoTailoring }
      : {}),
  };
}

export interface FireOutcome {
  status: "success" | "failed" | "skipped";
  detail: string | null;
  /** True when the failure should stop all further automatic runs (D5). */
  pauses: boolean;
  skippedProfiles?: string[];
  skippedDisabledSources?: string[];
}

/**
 * Assemble and start one schedule's run, and report how it went.
 *
 * Split from the tick so "Run now" can use exactly the same path — the whole
 * point of the assembly extraction is that there is one derivation of what a
 * run does, not one per entry point.
 */
export async function fireSchedule(
  schedule: RunSchedule,
): Promise<FireOutcome> {
  const sources = await resolveSources(schedule);
  const assembled = await assembleRun(buildRunBody(schedule, sources), {
    logRoute: `scheduler:${schedule.id}`,
    // The stored list is months old by the time it fires; a source disabled
    // since must not fail the whole run.
    skipDisabledSources: true,
  });

  if (!assembled.ok) {
    return {
      status: "failed",
      detail: assembled.error.message,
      // An assembly error is a configuration problem that will repeat every
      // pass until someone looks at it, so it stops the schedule rather than
      // burning a run an hour for ever.
      pauses: true,
    };
  }
  if (assembled.kind !== "sequence") {
    // Unreachable: a schedule always sends `profileIds`. Narrowed rather than
    // asserted away so the type stays honest.
    return {
      status: "failed",
      detail: "Scheduled runs must resolve to a profile sequence",
      pauses: true,
    };
  }

  runProfileSequence(assembled.entries, { trigger: "schedule" }).catch(
    (error) => {
      logger.error("Scheduled run failed", { scheduleId: schedule.id, error });
    },
  );

  return {
    status: "success",
    detail: describeFire(
      assembled.skippedProfiles,
      assembled.skippedDisabledSources,
    ),
    pauses: false,
    skippedProfiles: assembled.skippedProfiles,
    skippedDisabledSources: assembled.skippedDisabledSources,
  };
}

function describeFire(
  skippedProfiles: string[],
  skippedDisabledSources: string[],
): string | null {
  const notes: string[] = [];
  if (skippedProfiles.length > 0) {
    notes.push(`Skipped profiles: ${skippedProfiles.join(", ")}`);
  }
  if (skippedDisabledSources.length > 0) {
    notes.push(
      `Skipped disabled sources: ${skippedDisabledSources.join(", ")}`,
    );
  }
  return notes.length > 0 ? notes.join(". ") : null;
}

/** Stop all automatic runs until a user clears it. */
async function pauseScheduling(reason: string): Promise<void> {
  await setSetting("schedulingPausedReason", reason);
}

export async function isSchedulingPaused(): Promise<string | null> {
  const settings = await getEffectiveSettings();
  return settings.schedulingPausedReason ?? null;
}

export async function resumeScheduling(): Promise<void> {
  await setSetting("schedulingPausedReason", null);
}

/**
 * One scheduler pass.
 *
 * Returns what it did, for the tests and for logging; the interval ignores it.
 */
export async function runSchedulerPass(now: Date = new Date()): Promise<{
  acted: "paused" | "none" | "deferred" | "fired";
  scheduleId?: string;
}> {
  // A pause is not a skip: `next_fire_at` is deliberately left alone, so
  // whatever was due stays due the moment scheduling resumes.
  if (await isSchedulingPaused()) return { acted: "paused" };

  const schedules = await getAllRunSchedules();
  const due = schedules.find(
    (schedule) =>
      schedule.enabled &&
      schedule.nextFireAt !== null &&
      new Date(schedule.nextFireAt).getTime() <= now.getTime(),
  );
  if (!due) return { acted: "none" };

  // Someone else owns the pipeline. Defer WITHOUT advancing the target, so the
  // run happens as soon as the pipeline is free rather than being lost.
  if (getPipelineStatus().isRunning)
    return { acted: "deferred", scheduleId: due.id };

  // Claimed synchronously before the first await below, the same way the run
  // route does it: a read-then-act check would let this pass and a manual run
  // both proceed while awaiting, and the chain's legs would silently bounce.
  if (!tryBeginProfileSequence()) {
    return { acted: "deferred", scheduleId: due.id };
  }

  let handedOff = false;
  try {
    // NOT resetting the global rate-limit latch here, deliberately. The run
    // route clears it because "a USER starting a run is the signal that the
    // limit may have passed" — a timer is not a user, and a latched limit is
    // itself one of the things that pauses scheduling, so clearing it every
    // pass would defeat that check.
    const outcome = await fireSchedule(due);
    handedOff = outcome.status === "success";

    const next = await computeNextFire(due, now);
    await recordRunScheduleFire(due.id, {
      firedAt: now,
      status: outcome.status,
      detail: outcome.detail,
      // Advanced even on failure: the target is when this schedule NEXT wants
      // to run, and leaving it in the past would re-fire the same failure
      // every pass. What stops a broken schedule repeating is the pause.
      nextFireAt: next,
    });

    if (outcome.status === "failed" && outcome.pauses) {
      await pauseScheduling(
        `"${due.name}" failed: ${outcome.detail ?? "unknown error"}`,
      );
    }
    return { acted: "fired", scheduleId: due.id };
  } finally {
    // Ownership passes to the sequence, which releases the claim in its own
    // `finally`. Any other exit must give it back, or every later run 409s and
    // the app believes a run is in progress for ever.
    if (!handedOff) endProfileSequence();
  }
}

/**
 * Check after a chain finishes whether a rate limit latched.
 *
 * `summarize()` reports a partially-successful rate-limited chain as
 * `completed`, so the latch is the only honest signal that the run stopped
 * because the account ran out rather than because it finished.
 */
export async function pauseIfRateLimited(scheduleName: string): Promise<void> {
  if (!isRateLimitStopped()) return;
  await pauseScheduling(
    `"${scheduleName}" stopped on an LLM rate limit. Scheduling is paused until you resume it.`,
  );
}

let timer: ReturnType<typeof setInterval> | null = null;

/** How often the tick looks for a due schedule. */
const TICK_INTERVAL_MS = 60_000;

/**
 * Arm the tick. Called once from `startServer` after `listen`, alongside the
 * auth-session cleanup, plus one immediate pass so a boot after downtime
 * catches up a schedule that came due while the process was gone.
 */
export function startScheduler(): void {
  if (timer) return;
  const pass = () => {
    void runSchedulerPass().catch((error) => {
      logger.error("Scheduler pass failed", error);
    });
  };
  timer = setInterval(pass, TICK_INTERVAL_MS);
  // Unref'd so the interval never holds the process open on shutdown.
  timer.unref?.();
  pass();
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Recompute a schedule's target, for a caller that just created or enabled it.
 *
 * A schedule with no target never becomes due; one carrying a target from
 * before a long pause would fire the instant it is switched back on.
 */
export async function rearmSchedule(id: string): Promise<void> {
  const schedule = await getRunSchedule(id);
  if (!schedule || !schedule.enabled) return;
  const next = await computeNextFire(schedule, new Date());
  await updateRunSchedule(id, { nextFireAt: next?.toISOString() ?? null });
}
