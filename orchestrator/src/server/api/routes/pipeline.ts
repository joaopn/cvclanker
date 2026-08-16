import {
  AppError,
  badRequest,
  conflict,
  notFound,
  requestTimeout,
  serviceUnavailable,
} from "@infra/errors";
import { fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { setupSse, startSseHeartbeat, writeSseData } from "@infra/sse";
import {
  type ExtractorRegistry,
  getExtractorRegistry,
} from "@server/extractors/registry";
import {
  clearProfileRunPageTarget,
  endProfileSequence,
  getPipelineStatus,
  isProfileSequenceActive,
  type ProfileSequenceEntry,
  requestPipelineCancel,
  requestProfileSequenceCancel,
  runPipeline,
  runProfileSequence,
  subscribeToProgress,
  targetProfileRunPage,
  tryBeginProfileSequence,
} from "@server/pipeline/index";
import { getRunJobs } from "@server/pipeline/run-job-capture";
import * as pipelineRepo from "@server/repositories/pipeline";
import { getProfile } from "@server/repositories/profiles";
import { getEnabledProviderInstances } from "@server/repositories/provider-instances";
import { getEnabledExtractorIds } from "@server/repositories/source-configs";
import { resetRateLimitBudget } from "@server/services/llm/rate-limit-budget";
import { getDefaultProfile } from "@server/services/profiles";
import { getEffectiveSettings } from "@server/services/settings";
import {
  type ExtractorSourceId,
  PIPELINE_EXTRACTOR_SOURCE_IDS,
} from "@shared/extractors";
import {
  createLocationIntent,
  planLocationSources,
} from "@shared/location-intelligence.js";
import {
  LOCATION_MATCH_STRICTNESS_VALUES,
  LOCATION_SEARCH_SCOPE_VALUES,
} from "@shared/location-preferences.js";
import { deriveMaxJobsPerTerm } from "@shared/run-budget.js";
import { parseSearchCitiesSetting } from "@shared/search-cities.js";
import {
  type PipelineConfig,
  type PipelineStatusResponse,
  type Profile,
  RUN_JOB_BUCKETS,
  type RunJobsResponse,
  SUITABILITY_CATEGORIES,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const pipelineRouter = Router();
const WORKPLACE_TYPE_VALUES = ["remote", "hybrid", "onsite"] as const;

/**
 * GET /api/pipeline/status - Get pipeline status
 */
pipelineRouter.get("/status", async (_req: Request, res: Response) => {
  try {
    const { isRunning } = getPipelineStatus();
    const lastRun = await pipelineRepo.getLatestPipelineRun();
    const data: PipelineStatusResponse = {
      isRunning,
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
    const { source, bucket, profileId } = runJobsQuerySchema.parse(req.query);
    const response: RunJobsResponse = {
      source,
      bucket,
      jobs: getRunJobs(source, bucket, profileId ?? ""),
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
 * POST /api/pipeline/run - Trigger the pipeline manually
 */
const runPipelineSchema = z.object({
  topN: z.number().min(1).max(50).optional(),
  minSuitabilityCategory: z.enum(SUITABILITY_CATEGORIES).optional(),
  // An empty array is meaningful: "run no built-in extractors" (used by a
  // provider-instance-only re-run). `undefined` = all enabled extractors.
  sources: z
    .array(
      z.enum(
        PIPELINE_EXTRACTOR_SOURCE_IDS as [
          (typeof PIPELINE_EXTRACTOR_SOURCE_IDS)[number],
          ...(typeof PIPELINE_EXTRACTOR_SOURCE_IDS)[number][],
        ],
      ),
    )
    .optional(),
  // Marketplace provider instance ids to scope the run to. `undefined` = all
  // enabled instances; `[]` = none; a list = only those instances.
  providerInstanceIds: z.array(z.string().min(1)).optional(),
  maxJobsPerTerm: z.number().int().min(1).max(10_000).optional(),
  searchTerms: z.array(z.string().trim().min(1)).optional(),
  country: z.string().trim().optional(),
  cityLocations: z.array(z.string().trim().min(1)).optional(),
  workplaceTypes: z
    .array(z.enum(WORKPLACE_TYPE_VALUES))
    .min(1)
    .max(3)
    .optional(),
  searchScope: z.enum(LOCATION_SEARCH_SCOPE_VALUES).optional(),
  matchStrictness: z.enum(LOCATION_MATCH_STRICTNESS_VALUES).optional(),
  enableAutoTailoring: z.boolean().optional(),
  // Per-source re-run: reconcile the scoped sources into the existing banner
  // funnel instead of resetting every source's results.
  partial: z.boolean().optional(),
  // Resolve the run's scrape config from this Profile. Body fields still win
  // per-field (one-off overrides); absent → the default Profile.
  profileId: z.string().min(1).optional(),
  // Run several Profiles one after another. Deliberately no `.max()`: the count
  // is bounded by how many Profiles exist, and an invented ceiling would be a
  // magic number. Cannot be combined with `profileId`, `partial`, `sources` or
  // `providerInstanceIds` (see the guards in the handler).
  profileIds: z.array(z.string().min(1)).min(1).optional(),
});

type RunBody = z.infer<typeof runPipelineSchema>;

interface ResolveRunConfigArgs {
  body: RunBody;
  profile: Profile | null;
  enabledExtractorIds: Set<string>;
  enabledInstanceIds: Set<string>;
  loadRegistry: () => Promise<ExtractorRegistry | null>;
}

type ResolveRunConfigResult =
  | { ok: true; config: Partial<PipelineConfig> }
  | { ok: false; error: AppError };

/**
 * Turn one Profile (plus the request body's per-field overrides) into a
 * pipeline config, or into the error that should fail the request.
 *
 * Everything here is per-profile. The three profile-independent loads — the
 * enabled-extractor ids, the enabled provider instances, and the registry
 * loader — are passed in so a multi-profile request does them once rather than
 * once per profile.
 */
async function resolveProfileRunConfig(
  args: ResolveRunConfigArgs,
): Promise<ResolveRunConfigResult> {
  const {
    body,
    profile,
    enabledExtractorIds,
    enabledInstanceIds,
    loadRegistry,
  } = args;
  const profileConfig = profile?.config ?? null;

  const resolvedSearchTerms = body.searchTerms ?? profileConfig?.searchTerms;
  const resolvedProviderInstanceIds =
    body.providerInstanceIds ?? profileConfig?.providerInstanceIds;

  const locationIntent = createLocationIntent({
    selectedCountry: body.country ?? profileConfig?.searchCountry,
    cityLocations:
      body.cityLocations ??
      (profileConfig
        ? parseSearchCitiesSetting(profileConfig.searchCities)
        : undefined),
    workplaceTypes: body.workplaceTypes ?? profileConfig?.workplaceTypes,
    geoScope: body.searchScope ?? profileConfig?.locationSearchScope,
    matchStrictness:
      body.matchStrictness ?? profileConfig?.locationMatchStrictness,
  });

  // Sources: a body list wins verbatim (including `[]` = "no built-in
  // extractors"). Otherwise expand the Search Profile's pinned extractor ids
  // to their platform ids via the registry. An empty pin set means NO
  // extractors — a tick means what it says, and there is no "empty = all"
  // fallback. No profile at all → undefined → discovery uses every enabled
  // extractor.
  let resolvedSources: ExtractorSourceId[] | undefined;
  if (body.sources !== undefined) {
    resolvedSources = body.sources;
  } else if (profileConfig) {
    if (profileConfig.enabledSourceIds.length === 0) {
      // Short-circuit before the registry load: an unavailable registry must
      // not turn a "no sources selected" 400 into a 503.
      resolvedSources = [];
    } else {
      const registry = await loadRegistry();
      if (!registry) {
        return { ok: false, error: registryUnavailable() };
      }
      const pinned = new Set(profileConfig.enabledSourceIds);
      resolvedSources = Array.from(registry.manifestBySource.entries())
        .filter(([, manifest]) => pinned.has(manifest.id))
        .map(([platform]) => platform);
    }
  }

  // Location compatibility is profile-dependent (it reads the resolved intent),
  // unlike the unknown/disabled source checks the caller already ran.
  if (body.sources && body.sources.length > 0) {
    const sourcePlans = planLocationSources({
      intent: locationIntent,
      sources: body.sources,
    });
    if (sourcePlans.incompatibleSources.length > 0) {
      const incompatible = sourcePlans.plans
        .filter((plan) => !plan.isCompatible)
        .map((plan) => ({
          source: plan.source,
          reasons: plan.reasons,
        }));

      return {
        ok: false,
        error: badRequest(
          "Requested sources are incompatible with the selected location setup",
          { incompatibleSources: incompatible },
        ),
      };
    }
  }

  // EFFECTIVE = selected AND enabled. The guard tests this intersection, not
  // the raw selection: a Search Profile pinned to a source that was later
  // disabled on the Sources page has a NON-empty pin list, so a selection-only
  // guard stays silent — discovery then drops the source (a bare `continue`
  // at the grouping step) and the run succeeds having scraped nothing. Both
  // sets must be empty to reject: the per-source re-run button deliberately
  // empties one side to scope the run to the other.
  const effectiveInstanceIds =
    resolvedProviderInstanceIds === undefined
      ? Array.from(enabledInstanceIds)
      : resolvedProviderInstanceIds.filter((id) => enabledInstanceIds.has(id));

  let effectiveSourceCount = 0;
  if (resolvedSources === undefined || resolvedSources.length > 0) {
    const registry = await loadRegistry();
    if (!registry) {
      return { ok: false, error: registryUnavailable() };
    }
    const candidates =
      resolvedSources ?? Array.from(registry.manifestBySource.keys());
    effectiveSourceCount = candidates.filter((source) => {
      const manifest = registry.manifestBySource.get(source);
      return manifest !== undefined && enabledExtractorIds.has(manifest.id);
    }).length;
  }

  if (effectiveSourceCount === 0 && effectiveInstanceIds.length === 0) {
    return {
      ok: false,
      error: badRequest(
        profile
          ? `No sources are enabled for the "${profile.name}" search profile. Enable a source on the Sources page, then select it in the search profile.`
          : "No sources are enabled for this run. Enable a source on the Sources page, then select it in the search profile.",
      ),
    };
  }

  // maxJobsPerTerm: a body value wins; otherwise derive it from the Profile's
  // run budget spread across the run's compatible extractor sources × terms
  // (provider instances excluded from the divisor, mirroring the client).
  let resolvedMaxJobsPerTerm = body.maxJobsPerTerm;
  if (resolvedMaxJobsPerTerm === undefined && profileConfig) {
    const compatibleSourceCount = resolvedSources
      ? planLocationSources({
          intent: locationIntent,
          sources: resolvedSources,
        }).compatibleSources.length
      : 0;
    resolvedMaxJobsPerTerm = deriveMaxJobsPerTerm({
      budget: profileConfig.runBudget,
      termCount: (resolvedSearchTerms ?? []).length,
      sourceCount: compatibleSourceCount,
    });
  }

  return {
    ok: true,
    config: {
      topN: body.topN ?? profileConfig?.topN,
      minSuitabilityCategory:
        body.minSuitabilityCategory ?? profileConfig?.minSuitabilityCategory,
      sources: resolvedSources,
      providerInstanceIds: resolvedProviderInstanceIds,
      maxJobsPerTerm: resolvedMaxJobsPerTerm,
      searchTerms: resolvedSearchTerms,
      scrapeMaxAgeDays: profileConfig?.scrapeMaxAgeDays,
      // The scrape watermarks the "since last run" window reads and advances
      // are per-profile, so the flag is inert on a profile-less run.
      profileId: profile?.id,
      scrapeSinceLastRun: profileConfig?.scrapeSinceLastRun,
      blockedCompanyKeywords: profileConfig?.blockedCompanyKeywords,
      locationIntent,
      enableAutoTailoring: body.enableAutoTailoring,
      partial: body.partial,
    },
  };
}

const registryUnavailable = () =>
  serviceUnavailable(
    "Extractor registry is unavailable. Try again after fixing startup errors.",
  );

pipelineRouter.post("/run", async (req: Request, res: Response) => {
  // Set once the sequence slot is claimed and still owned by THIS handler.
  // Handing the entries to `runProfileSequence` transfers ownership (its
  // `finally` releases), so the flag is cleared before the hand-off.
  let holdsSequenceClaim = false;
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

    if (body.profileIds) {
      // Symmetrically: starting a chain while a single run is in flight would
      // burn through every profile instantly on that same guard.
      if (getPipelineStatus().isRunning) {
        return fail(
          res,
          conflict("A pipeline run is already in progress. Cancel it first."),
        );
      }

      // These combinations have no coherent meaning across N profiles, and
      // `partial` would make each profile accrete the previous one's funnel
      // rows and captures. Refusing them is also what keeps the multi path free
      // of body-driven source validation entirely.
      const conflictingKey =
        body.profileId !== undefined
          ? "profileId"
          : body.partial !== undefined
            ? "partial"
            : body.sources !== undefined
              ? "sources"
              : body.providerInstanceIds !== undefined
                ? "providerInstanceIds"
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
    }

    // A user starting a run is the signal that the rate limit may have passed,
    // so the global stop latch clears here — NOT per profile, or a chain would
    // re-hit the same wall for every remaining profile. Placed AFTER the 409
    // guards on purpose: a REJECTED run must not clear the latch of the chain
    // it just bounced off, which would let that chain sail on into the wall.
    resetRateLimitBudget(
      (await getEffectiveSettings()).llmRateLimitRetries.value,
    );

    let cachedRegistry: ExtractorRegistry | null = null;
    let registryFailed = false;
    const loadRegistry = async (): Promise<ExtractorRegistry | null> => {
      if (cachedRegistry) return cachedRegistry;
      if (registryFailed) return null;
      try {
        cachedRegistry = await getExtractorRegistry();
        return cachedRegistry;
      } catch (error) {
        registryFailed = true;
        logger.error("Extractor registry unavailable during run assembly", {
          route: "/api/pipeline/run",
          error,
        });
        return null;
      }
    };

    // A source runs only when the User Profile has it enabled (Sources page)
    // AND the run selects it. Both sets are needed below to gate on the
    // EFFECTIVE selection rather than the raw one. Profile-independent, so a
    // multi-profile request loads them once, not once per profile.
    const enabledExtractorIds = new Set(await getEnabledExtractorIds());
    const enabledInstanceIds = new Set(
      (await getEnabledProviderInstances()).map((row) => row.id),
    );

    // Body-provided sources are validated here (unknown → 400, disabled → 400)
    // because they depend on the body alone, not on any profile — running them
    // per profile would produce N identical errors attributed to an arbitrary
    // profile. The location-compatibility check IS profile-dependent and lives
    // in `resolveProfileRunConfig`. Profile-derived sources are NOT gated —
    // discovery skips incompatible ones rather than failing the run.
    if (body.sources && body.sources.length > 0) {
      const registry = await loadRegistry();
      if (!registry) {
        return fail(res, registryUnavailable());
      }
      const unavailableSources = body.sources.filter(
        (source) => !registry.manifestBySource.has(source),
      );
      if (unavailableSources.length > 0) {
        return fail(
          res,
          badRequest(
            `Requested sources are not available at runtime: ${unavailableSources.join(", ")}`,
            { unavailableSources },
          ),
        );
      }

      // Gate the body list on enablement too, mirroring what provider
      // instances already do below. Without this a disabled extractor passes
      // every check here and is then dropped silently at grouping, so the run
      // succeeds having scraped nothing.
      const disabledSources = body.sources.filter((source) => {
        const manifest = registry.manifestBySource.get(source);
        return manifest !== undefined && !enabledExtractorIds.has(manifest.id);
      });
      if (disabledSources.length > 0) {
        return fail(
          res,
          badRequest(
            `Requested sources are not enabled: ${disabledSources.join(", ")}`,
            { disabledSources },
          ),
        );
      }
    }

    if (body.providerInstanceIds && body.providerInstanceIds.length > 0) {
      const unknownInstanceIds = body.providerInstanceIds.filter(
        (id) => !enabledInstanceIds.has(id),
      );
      if (unknownInstanceIds.length > 0) {
        return fail(
          res,
          badRequest(
            `Requested provider instances are not enabled or do not exist: ${unknownInstanceIds.join(", ")}`,
            { unknownInstanceIds },
          ),
        );
      }
    }

    // Multi-profile: resolve EVERY profile before starting anything, so a
    // broken profile late in the list fails the whole request instead of being
    // discovered after earlier profiles have already scraped.
    if (body.profileIds) {
      const entries: ProfileSequenceEntry[] = [];
      for (const profileId of body.profileIds) {
        const profile = await getProfile(profileId);
        if (!profile) {
          return fail(res, notFound(`Profile not found: ${profileId}`));
        }
        const resolved = await resolveProfileRunConfig({
          body,
          profile,
          enabledExtractorIds,
          enabledInstanceIds,
          loadRegistry,
        });
        if (!resolved.ok) {
          return fail(res, resolved.error);
        }
        entries.push({
          profile: { id: profile.id, name: profile.name },
          config: resolved.config,
        });
      }

      runWithRequestContext({}, () => {
        runProfileSequence(entries).catch((error) => {
          logger.error("Background multi-profile run failed", error);
        });
      });
      // Ownership of the claim has passed to the sequence, which releases it in
      // its own `finally`. Cleared after the call, not before, so a throw on
      // the way in still lets this handler's `finally` give the slot back.
      holdsSequenceClaim = false;
      return ok(res, {
        message: "Pipeline started",
        profileCount: entries.length,
      });
    }

    // Resolve the Profile that backs this run: an explicit id (404 if missing),
    // else the default Profile. A null default (pre-seed only) means the run is
    // driven from the body alone — today's behavior. Every scrape field
    // resolves `body.X ?? profile.config.X`, so a one-off body override wins
    // per-field without persisting to the Profile.
    let profile: Awaited<ReturnType<typeof getProfile>> = null;
    if (body.profileId) {
      profile = await getProfile(body.profileId);
      if (!profile) {
        return fail(res, notFound(`Profile not found: ${body.profileId}`));
      }
    } else {
      profile = await getDefaultProfile();
    }

    const resolved = await resolveProfileRunConfig({
      body,
      profile,
      enabledExtractorIds,
      enabledInstanceIds,
      loadRegistry,
    });
    if (!resolved.ok) {
      return fail(res, resolved.error);
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
        ? targetProfileRunPage(body.profileId)
        : false;

    // Start pipeline in background
    runWithRequestContext({}, () => {
      runPipeline(resolved.config)
        .catch((error) => {
          logger.error("Background pipeline run failed", error);
        })
        // Chained onto the CAUGHT promise, so it never rejects: an uncaught
        // `.finally` here would be an unhandled rejection on a failing run.
        .finally(() => {
          if (pageScoped) clearProfileRunPageTarget();
        });
    });
    ok(res, { message: "Pipeline started" });
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
