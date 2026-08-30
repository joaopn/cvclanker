import {
  AppError,
  badRequest,
  conflict,
  notFound,
  requestTimeout,
} from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { setupSse, startSseHeartbeat, writeSseData } from "@infra/sse";
import { getExtractorRegistry } from "@server/extractors/registry";
import {
  clearProfileRunPageTarget,
  dismissRunBanner,
  endProfileSequence,
  getProgress as getPipelineProgress,
  getPipelineStatus,
  isProfileSequenceActive,
  requestPipelineCancel,
  requestProfileSequenceCancel,
  runPipeline,
  runProfileSequence,
  setActiveRunTrigger,
  subscribeToProgress,
  targetProfileRunPage,
  tryBeginProfileSequence,
} from "@server/pipeline/index";
import { getRunJobs } from "@server/pipeline/run-job-capture";
import { getProvider } from "@server/providers";
import * as pipelineRepo from "@server/repositories/pipeline";
import { getProfile } from "@server/repositories/profiles";
import { getEnabledProviderInstances } from "@server/repositories/provider-instances";
import {
  getAllSourceConfigs,
  getEnabledExtractorIds,
} from "@server/repositories/source-configs";
import { getScrapeWatermarks } from "@server/repositories/source-scrape-watermarks";
import { resetRateLimitBudget } from "@server/services/llm/rate-limit-budget";
import {
  assembleRun,
  buildRunLocationIntent,
  registryUnavailable,
  runPipelineSchema,
} from "@server/services/pipeline-run/assemble";
import {
  extractorHonoursRunWindow,
  instanceMaxAgeBuckets,
} from "@server/services/pipeline-run/run-window";
import { getDefaultProfile } from "@server/services/profiles";
import { getEffectiveSettings } from "@server/services/settings";
import type { ExtractorSourceId } from "@shared/extractors";
import { planLocationSources } from "@shared/location-intelligence.js";
import {
  type PipelineStatusResponse,
  type Profile,
  type ProfileConfig,
  RUN_JOB_BUCKETS,
  RUN_TRIGGERS,
  type RunJobsResponse,
  type RunOptionSource,
  type RunOptionsResponse,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const pipelineRouter = Router();

/**
 * GET /api/pipeline/status - Get pipeline status
 */
pipelineRouter.get("/status", async (_req: Request, res: Response) => {
  try {
    const { isRunning, runningTrigger } = getPipelineStatus();
    const lastRun = await pipelineRepo.getLatestPipelineRun();
    const data: PipelineStatusResponse = {
      isRunning,
      runningTrigger,
      lastRun,
      nextScheduledRun: null,
    };
    ok(res, data);
  } catch (error) {
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
});

const dismissProgressSchema = z.object({
  /**
   * The run being dismissed. A dismissal that names a run the server has since
   * moved past is ignored rather than applied to whatever is current.
   */
  startedAt: z.string().min(1).optional(),
  /**
   * Which partition's table to hide. Absent means the manual one — the table
   * every client had before scheduled runs existed.
   */
  trigger: z.enum(RUN_TRIGGERS).optional(),
});

/**
 * Hide the current run's banner for every viewer.
 *
 * Server-side because the banner belongs to the RUN, not to a browser: closing
 * the window used to be indistinguishable from dismissing it, and reopening
 * resurrected a banner already dealt with.
 */
pipelineRouter.post("/progress/dismiss", (req: Request, res: Response) => {
  const parsed = dismissProgressSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, badRequest("Invalid dismiss payload"));
  }
  // The two tables are dismissed separately: closing a finished manual run's
  // banner must not also hide a scheduled run that is still going, and vice
  // versa. Safe on the wire now that every client consumer filters on the
  // partition it renders — the fan-out below still reaches every listener.
  const trigger = parsed.data.trigger ?? "manual";
  dismissRunBanner(parsed.data.startedAt, trigger);
  ok(res, { dismissed: getPipelineProgress(trigger).dismissed });
});

/**
 * GET /api/pipeline/progress - Server-Sent Events endpoint for live progress
 */
pipelineRouter.get("/progress", (req: Request, res: Response) => {
  setupSse(res, {
    cacheControl: "no-cache, no-transform",
    disableBuffering: true,
    flushHeaders: true,
  });

  // Send initial progress
  const sendProgress = (data: unknown) => {
    writeSseData(res, data);
  };

  // Subscribe to progress updates
  const unsubscribe = subscribeToProgress(sendProgress);

  // Send heartbeat every 30 seconds to keep connection alive
  const stopHeartbeat = startSseHeartbeat(res);

  // Cleanup on close
  req.on("close", () => {
    stopHeartbeat();
    unsubscribe();
  });
});

/**
 * GET /api/pipeline/runs - Get recent pipeline runs
 */
pipelineRouter.get("/runs", async (_req: Request, res: Response) => {
  try {
    const runs = await pipelineRepo.getRecentPipelineRuns(20);
    ok(res, runs);
  } catch (error) {
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
});

const runJobsQuerySchema = z.object({
  source: z.string().min(1),
  // Which profile's page the count was clicked on. Absent for an ordinary
  // single-profile run, whose captures live in the unscoped store.
  profileId: z.string().min(1).optional(),
  // Which partition's captures to read. Absent means the manual one, matching
  // the store's own default: a read arrives long after the capture, so
  // resolving it against whatever is running now is the bug this names away.
  trigger: z.enum(RUN_TRIGGERS).optional(),
  // The cast is needed here and not for `RUN_TRIGGERS` above: this list is
  // typed `readonly RunJobBucket[]`, which zod cannot read as an enum tuple,
  // where `RUN_TRIGGERS` is `as const` and already one.
  bucket: z.enum(
    RUN_JOB_BUCKETS as [
      (typeof RUN_JOB_BUCKETS)[number],
      ...(typeof RUN_JOB_BUCKETS)[number][],
    ],
  ),
});

/**
 * GET /api/pipeline/run-jobs - jobs behind a per-source funnel count for the
 * current run (captured in-memory; resets when the next run starts).
 */
pipelineRouter.get("/run-jobs", (req: Request, res: Response) => {
  try {
    const { source, bucket, profileId, trigger } = runJobsQuerySchema.parse(
      req.query,
    );
    const response: RunJobsResponse = {
      source,
      bucket,
      jobs: getRunJobs(source, bucket, profileId ?? "", trigger ?? "manual"),
    };
    ok(res, response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
});

/**
 * GET /api/pipeline/runs/:id/insights - Get exact and inferred metrics for a run
 */
pipelineRouter.get(
  "/runs/:id/insights",
  async (req: Request, res: Response) => {
    try {
      const insights = await pipelineRepo.getPipelineRunInsights(req.params.id);
      if (!insights) {
        return fail(res, notFound("Pipeline run not found"));
      }
      ok(res, insights);
    } catch (error) {
      fail(
        res,
        new AppError({
          status: 500,
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
  },
);

/**
 * Everything the run menu needs to offer a scoped run.
 *
 * Computed server-side because the client cannot see any of it: which sources
 * the Sources page has enabled, which each Profile pins, every one's max job
 * age and bucket set, and when it last covered its window. It also resolves the
 * DEFAULT profile the same way `POST /run` does, so the menu never offers a set
 * the run would not use.
 *
 * Several profile ids answer for a CHAIN: the offered set is the union of what
 * each profile would run, because the chain runs each leg with its own pins and
 * the menu's list narrows all of them. Where profiles disagree, the answer is
 * the one that governs the whole chain — the TIGHTEST ceiling, and the OLDEST
 * coverage, since a run window has to satisfy every leg.
 */
pipelineRouter.get(
  "/run-options",
  asyncRoute(async (req: Request, res: Response) => {
    const rawIds =
      typeof req.query.profileIds === "string" &&
      req.query.profileIds.length > 0
        ? req.query.profileIds.split(",").filter(Boolean)
        : typeof req.query.profileId === "string" &&
            req.query.profileId.length > 0
          ? [req.query.profileId]
          : [];

    const profiles: Profile[] = [];
    for (const id of rawIds) {
      const profile = await getProfile(id);
      if (!profile) {
        return fail(res, notFound(`Profile not found: ${id}`));
      }
      profiles.push(profile);
    }
    if (profiles.length === 0) {
      const fallback = await getDefaultProfile();
      if (fallback) profiles.push(fallback);
    }

    const registry = await getExtractorRegistry().catch(() => null);
    if (!registry) return fail(res, registryUnavailable());

    const enabledExtractorIds = new Set(await getEnabledExtractorIds());
    const sourceConfigs = await getAllSourceConfigs();
    const configByExtractor = new Map(
      sourceConfigs.map((row) => [row.extractorId, row]),
    );
    const enabledInstances = await getEnabledProviderInstances();

    /** Merge one profile's view of a source into the union. */
    const merged = new Map<string, RunOptionSource>();
    const mergeSource = (next: RunOptionSource) => {
      const current = merged.get(next.key);
      if (!current) {
        merged.set(next.key, next);
        return;
      }
      merged.set(next.key, {
        ...current,
        // A platform one profile can run is runnable in the chain; only one no
        // profile can run stays dead.
        platforms: Array.from(
          new Set([...current.platforms, ...next.platforms]),
        ),
        incompatible: current.incompatible.filter((entry) =>
          next.incompatible.some((other) => other.platform === entry.platform),
        ),
        // Null dominates: a profile that has never covered this source makes
        // the chain's next run reach back as far as it ever would.
        lastScrapedAt:
          current.lastScrapedAt === null || next.lastScrapedAt === null
            ? null
            : current.lastScrapedAt < next.lastScrapedAt
              ? current.lastScrapedAt
              : next.lastScrapedAt,
        // The tightest ceiling governs: the window has to pass every leg's gate.
        capDays:
          current.capDays === null
            ? next.capDays
            : next.capDays === null
              ? current.capDays
              : Math.min(current.capDays, next.capDays),
      });
    };

    // An install with no Profiles at all still runs: the route resolves no
    // profile, so discovery falls back to every enabled source. The menu has to
    // answer for that same run or its Run button is dead on a fresh install.
    const views: Array<{
      config: ProfileConfig | null;
      watermarks: Map<string, string>;
    }> =
      profiles.length > 0
        ? await Promise.all(
            profiles.map(async (profile) => ({
              config: profile.config,
              watermarks: await getScrapeWatermarks(profile.id),
            })),
          )
        : [{ config: null, watermarks: new Map<string, string>() }];

    for (const { config: profileConfig, watermarks } of views) {
      const capDays = profileConfig?.scrapeMaxAgeDays ?? null;
      const locationIntent = buildRunLocationIntent(profileConfig);

      // EFFECTIVE = enabled on the Sources page AND pinned by the Profile. That
      // is exactly what a plain Run would use, which is what makes the menu
      // purely subtractive: unticking narrows a run, it can never widen one.
      // With no Profile there is nothing to pin, so every enabled source is on.
      const pinnedExtractorIds = profileConfig
        ? new Set(profileConfig.enabledSourceIds)
        : enabledExtractorIds;

      for (const [manifestId, manifest] of registry.manifests) {
        if (!enabledExtractorIds.has(manifestId)) continue;
        if (!pinnedExtractorIds.has(manifestId)) continue;

        const plans = planLocationSources({
          intent: locationIntent,
          sources: manifest.providesSources,
        });
        const honoursRunWindow = extractorHonoursRunWindow(
          manifest,
          configByExtractor.get(manifestId),
        );
        // Derived, not hardcoded: a manifest naming its field something else
        // would otherwise be reported as having no max-age concept at all.
        const maxAgeFieldKey =
          manifest.configSchema?.globalMappings.find(
            (mapping) => mapping.globalField === "maxAgeDays",
          )?.sourceField ?? "max_age_days";
        const hasOwnMaxAge =
          manifest.configSchema?.fields.some(
            (field) => field.key === maxAgeFieldKey,
          ) === true;

        mergeSource({
          key: manifestId,
          kind: "extractor",
          label: manifest.displayName,
          // Only the compatible platforms: an explicit `sources` list is gated
          // on location compatibility, so sending an incompatible one would 400
          // the run — where an omitted list has those same sources skipped
          // silently. `providesSources` is the manifest's own list, so every
          // entry is an extractor source id; `planLocationSources` widens it.
          platforms: plans.compatibleSources as ExtractorSourceId[],
          incompatible: plans.plans
            .filter((plan) => !plan.isCompatible)
            .map((plan) => ({ platform: plan.source, reasons: plan.reasons })),
          lastScrapedAt: watermarks.get(manifestId) ?? null,
          capDays: honoursRunWindow ? capDays : null,
          windowSupport: honoursRunWindow
            ? "run_window"
            : hasOwnMaxAge
              ? "own_max_age"
              : "ignores",
          maxAgeBuckets: null,
          note: manifest.description ?? null,
        });
      }

      // A remote-type Profile never runs Apify instances, so offering them
      // would show buttons that do nothing.
      const pinnedInstanceIds =
        profileConfig?.remoteProfile === true
          ? new Set<string>()
          : new Set(
              profileConfig?.providerInstanceIds ??
                enabledInstances.map((instance) => instance.id),
            );

      for (const instance of enabledInstances) {
        if (!pinnedInstanceIds.has(instance.id)) continue;
        const key = `${instance.providerId}:${instance.id}`;
        const buckets = instanceMaxAgeBuckets(instance);
        const template = instance.templateId
          ? getProvider(instance.providerId)?.templates.find(
              (candidate) => candidate.id === instance.templateId,
            )
          : undefined;

        mergeSource({
          key,
          kind: "provider_instance",
          label: instance.label,
          platforms: [],
          incompatible: [],
          lastScrapedAt: watermarks.get(key) ?? null,
          capDays: instance.maxAgeDays ?? capDays,
          windowSupport: "run_window",
          maxAgeBuckets: buckets ? [...buckets] : null,
          note: template?.maxAgeNote ?? null,
        });
      }
    }

    // The tightest ceiling any leg imposes — the one a single window must
    // satisfy for the whole chain. An uncapped profile imposes nothing, so it
    // is skipped rather than nulling the answer; that would claim "no ceiling"
    // while a sibling leg's gate still refused, and seed the day count from the
    // wrong number. Same rule as the per-source merge, deliberately.
    const profileCaps = profiles
      .map((profile) => profile.config.scrapeMaxAgeDays)
      .filter((cap): cap is number => typeof cap === "number" && cap > 0);
    // App-level, not per-Profile: the rows a refresh covers are the whole
    // database's, so a chain answers with the same numbers a single run does.
    const settings = await getEffectiveSettings();
    return ok(res, {
      profileIds: profiles.map((profile) => profile.id),
      sources: Array.from(merged.values()),
      capDays: profileCaps.length > 0 ? Math.min(...profileCaps) : null,
      // Only pre-press "since last run" when EVERY leg narrows; otherwise the
      // menu would claim a mode half the chain is not configured for.
      defaultSinceLastRun:
        profiles.length > 0 &&
        profiles.every((profile) => profile.config.scrapeSinceLastRun === true),
      defaultRefreshLiveStatus: settings.liveStatusRefreshEnabled.value,
      liveStatusRefreshLimit: settings.liveStatusRefreshLimit.value,
      liveStatusRefreshMinAgeHours: settings.liveStatusRefreshMinAgeHours.value,
    } satisfies RunOptionsResponse);
  }),
);

pipelineRouter.post("/run", async (req: Request, res: Response) => {
  // Set once the sequence slot is claimed and still owned by THIS handler.
  // Handing the entries to `runProfileSequence` transfers ownership (its
  // `finally` releases), so the flag is cleared before the hand-off.
  let holdsSequenceClaim = false;
  // The partition every run started here belongs to. Named once because BOTH
  // start paths below (the chain and the single run) and the page a re-run aims
  // at must agree — a scheduler slice has to move them together, and a default
  // hides one of them.
  const runTrigger = "manual" as const;
  try {
    const body = runPipelineSchema.parse(req.body);

    // A chain owns the pipeline until it ends. Without this, a run started in
    // the seconds-wide gap between two profiles wins the singleton, and the
    // chain's next profile is silently skipped — `runPipeline` reports
    // "already running" as a return value, so nothing surfaces it.
    if (isProfileSequenceActive()) {
      return fail(
        res,
        conflict("A multi-profile run is in progress. Cancel it first."),
      );
    }

    // Two ways to say what window to scrape; sending both is a contradiction,
    // not a precedence question. Refused rather than silently resolved.
    if (
      body.scrapeWindowDays !== undefined &&
      body.scrapeSinceLastRun === true
    ) {
      return fail(
        res,
        badRequest(
          "scrapeWindowDays cannot be combined with scrapeSinceLastRun: true — an explicit window and the since-last-run narrowing are alternatives.",
        ),
      );
    }

    if (body.profileIds) {
      // Symmetrically: starting a chain while a single run is in flight would
      // burn through every profile instantly on that same guard.
      if (getPipelineStatus().isRunning) {
        return fail(
          res,
          conflict("A pipeline run is already in progress. Cancel it first."),
        );
      }

      // `profileId` names one profile where `profileIds` names several, and
      // `partial` would make each profile accrete the previous one's funnel
      // rows and captures. `sources` / `providerInstanceIds` ARE allowed: they
      // narrow each profile's own selection rather than replacing it (see
      // `sourceSelectionMode`), which is the only reading that means anything
      // across N profiles with different pins.
      const conflictingKey =
        body.profileId !== undefined
          ? "profileId"
          : body.partial !== undefined
            ? "partial"
            : null;
      if (conflictingKey) {
        return fail(
          res,
          badRequest(`profileIds cannot be combined with ${conflictingKey}`),
        );
      }

      const uniqueIds = new Set(body.profileIds);
      if (uniqueIds.size !== body.profileIds.length) {
        return fail(res, badRequest("profileIds contains duplicate entries"));
      }

      // Claimed HERE, synchronously before the first await. A read-then-act
      // check would let two concurrent requests both pass while they await the
      // profile and registry loads below, and both start a chain — clobbering
      // each other's active-profile context and silently skipping profiles
      // (the pipeline singleton reports "already running" as a return value,
      // not a throw).
      if (!tryBeginProfileSequence()) {
        return fail(
          res,
          conflict("A multi-profile run is already in progress"),
        );
      }
      holdsSequenceClaim = true;
      // Beside the claim, for the same reason the scheduler does it: the claim
      // is what makes `getPipelineStatus()` report "running", and it reads the
      // trigger from a latch that `runProfileSequence` only sets several awaits
      // later.
      setActiveRunTrigger(runTrigger);
    }

    // A user starting a run is the signal that the rate limit may have passed,
    // so the global stop latch clears here — NOT per profile, or a chain would
    // re-hit the same wall for every remaining profile. Placed AFTER the 409
    // guards on purpose: a REJECTED run must not clear the latch of the chain
    // it just bounced off, which would let that chain sail on into the wall.
    resetRateLimitBudget(
      (await getEffectiveSettings()).llmRateLimitRetries.value,
    );

    // Everything from here to the start call is shared with the scheduler, so
    // it lives in `services/pipeline-run/assemble`. The guards above stay here:
    // the sequence claim has to be taken synchronously before the first await,
    // and the request-shape refusals describe the request rather than the run.
    const assembled = await assembleRun(body);
    if (!assembled.ok) {
      return fail(res, assembled.error);
    }

    if (assembled.kind === "sequence") {
      runWithRequestContext({}, () => {
        runProfileSequence(assembled.entries, { trigger: runTrigger }).catch(
          (error) => {
            logger.error("Background multi-profile run failed", error);
          },
        );
      });
      // Ownership of the claim has passed to the sequence, which releases it in
      // its own `finally`. Cleared after the call, not before, so a throw on
      // the way in still lets this handler's `finally` give the slot back.
      holdsSequenceClaim = false;
      return ok(res, {
        message: "Pipeline started",
        profileCount: assembled.entries.length,
        skippedProfiles: assembled.skippedProfiles,
      });
    }

    // A per-source re-run fired from one page of a multi-profile run reconciles
    // into THAT page — its funnel rows and its captured jobs — instead of into
    // whichever profile ran last. No page for this profile (an ordinary run, or
    // a chain the process has forgotten) leaves the flat funnel untouched.
    // Claimed only after every failure path above, so a rejected request never
    // leaves the banner aimed at a page. Skipped outright while a run is in
    // flight: `runPipeline` would reject this one on its singleton guard, and
    // seeding the page's rows first would have replaced the LIVE run's funnel.
    // Nothing awaits between here and `runPipeline` setting that flag, so the
    // check cannot go stale.
    const pageScoped =
      body.partial === true &&
      body.profileId !== undefined &&
      !getPipelineStatus().isRunning
        ? targetProfileRunPage(body.profileId, runTrigger)
        : false;

    // Start pipeline in background
    runWithRequestContext({}, () => {
      runPipeline(assembled.config, { trigger: runTrigger })
        .catch((error) => {
          logger.error("Background pipeline run failed", error);
        })
        // Chained onto the CAUGHT promise, so it never rejects: an uncaught
        // `.finally` here would be an unhandled rejection on a failing run.
        .finally(() => {
          if (pageScoped) clearProfileRunPageTarget();
        });
    });
    ok(res, {
      message: "Pipeline started",
      skippedDisabledSources: assembled.skippedDisabledSources,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    if (error instanceof Error && error.name === "AbortError") {
      return fail(res, requestTimeout("Request timed out"));
    }
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  } finally {
    // Any exit that did not hand the entries to the sequence must give the slot
    // back, or every later multi-profile run 409s and the app believes a run is
    // in progress forever.
    if (holdsSequenceClaim) {
      endProfileSequence();
    }
  }
});

/**
 * POST /api/pipeline/cancel - Request cancellation of active pipeline run
 */
pipelineRouter.post("/cancel", async (_req: Request, res: Response) => {
  try {
    // Stop the chain first, then the in-flight run. Gated on an ACTIVE
    // sequence: setting the flag during a plain single run would strand it
    // (only the sequence's `finally` clears it), and the next multi-profile run
    // would break on its first iteration and report "cancelled" having run
    // nothing.
    const sequenceActive = isProfileSequenceActive();
    if (sequenceActive) {
      requestProfileSequenceCancel();
    }

    const cancelResult = requestPipelineCancel();
    // A cancel landing in the gap between two profiles finds no in-flight run,
    // but the chain is still live and has just been told to stop — that is an
    // accepted cancellation, not a "nothing to cancel".
    if (!cancelResult.accepted && !sequenceActive) {
      return fail(res, conflict("No running pipeline to cancel"));
    }

    logger.info("Pipeline cancellation requested", {
      route: "/api/pipeline/cancel",
      action: "cancel",
      status: "accepted",
      pipelineRunId: cancelResult.pipelineRunId,
      alreadyRequested: cancelResult.alreadyRequested,
    });

    ok(res, {
      message: cancelResult.alreadyRequested
        ? "Pipeline cancellation already requested"
        : "Pipeline cancellation requested",
      pipelineRunId: cancelResult.pipelineRunId,
      alreadyRequested: cancelResult.alreadyRequested,
    });
  } catch (error) {
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
});
