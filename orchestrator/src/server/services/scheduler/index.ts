import { logger } from "@infra/logger";
import { getExtractorRegistry } from "@server/extractors/registry";
import {
  endProfileSequence,
  getPipelineStatus,
  getProgress,
  runProfileSequence,
  tryBeginProfileSequence,
} from "@server/pipeline/index";
import {
  getAllRunSchedules,
  recordRunScheduleFire,
  recordRunScheduleOutcome,
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
  /** "success" means the chain STARTED; its real result arrives later. */
  status: "success" | "failed" | "skipped";
  detail: string | null;
  /** True when the failure should stop all further automatic runs (D5). */
  pauses: boolean;
  skippedProfiles?: string[];
  skippedDisabledSources?: string[];
}

/**
 * Assemble and start one schedule's run, and report whether it STARTED.
 *
 * Split from the tick so "Run now" uses exactly the same path — the whole point
 * of the assembly extraction is one derivation of what a run does, not one per
 * entry point.
 *
 * THE CALLER MUST ALREADY HOLD THE SEQUENCE CLAIM, taken synchronously before
 * its first await, because that is `runProfileSequence`'s own contract: it
 * releases the claim in its `finally`, so starting a chain without one both
 * leaves `isProfileSequenceActive()` false for the whole run — which is what
 * guards the User-Profile DB swap — and releases a claim someone else may have
 * taken meanwhile. `status: "success"` means STARTED; the chain's real outcome
 * arrives later through `observeChainOutcome`.
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

  const startNote = describeFire(
    assembled.skippedProfiles,
    assembled.skippedDisabledSources,
  );
  void runProfileSequence(assembled.entries, { trigger: "schedule" })
    .catch((error) => {
      logger.error("Scheduled run failed", { scheduleId: schedule.id, error });
      return undefined;
    })
    // Chained onto the CAUGHT promise so it can never reject on its own.
    .then(() => observeChainOutcome(schedule, startNote));

  return {
    status: "success",
    detail: startNote,
    pauses: false,
    skippedProfiles: assembled.skippedProfiles,
    skippedDisabledSources: assembled.skippedDisabledSources,
  };
}

/**
 * Record what the chain actually did, once it has finished.
 *
 * `runProfileSequence` resolves to `void` and swallows every per-profile
 * failure (they are counted, not thrown), so starting it successfully says
 * nothing about the result — without this the card would read "success" for a
 * chain in which every profile failed. The terminal progress event is the same
 * thing the run banner shows, so this reads its verdict rather than inventing
 * a second one.
 *
 * `summarize()` reports a partially-successful rate-limited chain as
 * `completed`, so the latch is checked separately: it is the only honest signal
 * that the run stopped because the account ran out. That matters for money —
 * a latched limit left unnoticed means every later fire scrapes (billing per
 * result) and classifies nothing.
 */
async function observeChainOutcome(
  schedule: RunSchedule,
  startNote: string | null,
): Promise<void> {
  try {
    const progress = getProgress("schedule");
    const rateLimited = isRateLimitStopped();
    const failed = progress.step === "failed" || rateLimited;
    await recordRunScheduleOutcome(schedule.id, {
      status: failed
        ? "failed"
        : progress.step === "cancelled"
          ? "skipped"
          : "success",
      detail:
        [
          rateLimited
            ? "Stopped on an LLM rate limit."
            : (progress.error ?? progress.detail ?? progress.message ?? null),
          startNote,
        ]
          .filter(Boolean)
          .join(". ") || null,
    });
    if (rateLimited) {
      await pauseScheduling(
        `"${schedule.name}" stopped on an LLM rate limit. Scheduling is paused until you resume it.`,
      );
      return;
    }
    if (failed) {
      await pauseScheduling(
        `"${schedule.name}" failed: ${progress.error ?? "the run did not complete"}`,
      );
    }
  } catch (error) {
    // This runs detached from any request; a throw here would be an unhandled
    // rejection that tells nobody anything.
    logger.error("Could not record a scheduled run's outcome", {
      scheduleId: schedule.id,
      error,
    });
  }
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
    // Written BEFORE the chain starts, and the chain's own observer is then the
    // only later writer. The other order is a race: a chain that finishes fast
    // resolves its observer before this write lands, and "running" would
    // overwrite the real outcome.
    //
    // The target is advanced even when the fire fails: it says when this
    // schedule NEXT wants to run, and leaving it in the past would re-fire the
    // same failure every pass. What stops a broken schedule repeating is the
    // pause, not a stuck target.
    const next = await computeNextFire(due, now);
    await recordRunScheduleFire(due.id, {
      firedAt: now,
      status: "running",
      detail: null,
      nextFireAt: next,
    });

    const outcome = await fireSchedule(due);
    handedOff = outcome.status === "success";

    if (!handedOff) {
      await recordRunScheduleOutcome(due.id, {
        status: outcome.status,
        detail: outcome.detail,
      });
      if (outcome.pauses) {
        await pauseScheduling(
          `"${due.name}" failed: ${outcome.detail ?? "unknown error"}`,
        );
      }
    }
    return { acted: "fired", scheduleId: due.id };
  } finally {
    // Ownership passes to the sequence, which releases the claim in its own
    // `finally`. Any other exit must give it back, or every later run 409s and
    // the app believes a run is in progress for ever.
    if (!handedOff) endProfileSequence();
  }
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
