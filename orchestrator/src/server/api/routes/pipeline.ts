import {
  AppError,
  badRequest,
  conflict,
  notFound,
  requestTimeout,
  serviceUnavailable,
} from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { setupSse, startSseHeartbeat, writeSseData } from "@infra/sse";
import {
  type ExtractorRegistry,
  getExtractorRegistry,
} from "@server/extractors/registry";
import {
  clearProfileRunPageTarget,
  dismissRunBanner,
  endProfileSequence,
  getProgress as getPipelineProgress,
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
import { SCRAPE_WINDOW_MAX_DAYS } from "@shared/scrape-window.js";
import { parseSearchCitiesSetting } from "@shared/search-cities.js";
import { MAX_POOL_CONCURRENCY } from "@shared/settings-registry";
import {
  type PipelineConfig,
  type PipelineStatusResponse,
  type Profile,
  type ProfileConfig,
  type ProviderInstanceRow,
  RUN_JOB_BUCKETS,
  type RunJobsResponse,
  type RunOptionSource,
  type RunOptionsResponse,
  type SourceConfigRow,
  SUITABILITY_CATEGORIES,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import {
  describeRunWindowViolations,
  extractorHonoursRunWindow,
  findRunWindowViolations,
  instanceMaxAgeBuckets,
} from "./run-window";

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

const dismissProgressSchema = z.object({
  /**
   * The run being dismissed. A dismissal that names a run the server has since
   * moved past is ignored rather than applied to whatever is current.
   */
  startedAt: z.string().min(1).optional(),
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
  // No `trigger` on the wire yet. The server function takes one, but exposing
  // it here would let a request emit a pristine event for a partition nothing
  // has run — and the fan-out has no partition filter until the client slice
  // adds one, so every viewer's banner would blank.
  dismissRunBanner(parsed.data.startedAt, "manual");
  ok(res, { dismissed: getPipelineProgress("manual").dismissed });
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
      // Manual partition until the client slice can name one; the scheduled
      // store has no reader yet.
      jobs: getRunJobs(source, bucket, profileId ?? "", "manual"),
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
  // Per-run override of the `discoveryConcurrency` setting (same bounds).
  discoveryConcurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_POOL_CONCURRENCY)
    .optional(),
  // An explicit scrape window for this run, in days. Refused rather than
  // clamped when it exceeds a selected source's configured max job age — see
  // `findRunWindowViolations`.
  scrapeWindowDays: z
    .number()
    .int()
    .min(1)
    .max(SCRAPE_WINDOW_MAX_DAYS)
    .optional(),
  // Per-run override of the Profile's "only scrape since the last run" flag.
  // Sending `false` is how the run menu's explicit-window mode switches the
  // narrowing off for one run without touching the Profile.
  scrapeSinceLastRun: z.boolean().optional(),
  // Resolve the run's scrape config from this Profile. Body fields still win
  // per-field (one-off overrides); absent → the default Profile.
  profileId: z.string().min(1).optional(),
  // Run several Profiles one after another. Deliberately no `.max()`: the count
  // is bounded by how many Profiles exist, and an invented ceiling would be a
  // magic number. Cannot be combined with `profileId` or `partial` (see the
  // guards in the handler). `sources` / `providerInstanceIds` ARE allowed:
  // across a chain they narrow each profile's own selection, never replace it.
  profileIds: z.array(z.string().min(1)).min(1).optional(),
});

type RunBody = z.infer<typeof runPipelineSchema>;

interface ResolveRunConfigArgs {
  body: RunBody;
  profile: Profile | null;
  enabledExtractorIds: Set<string>;
  enabledInstanceIds: Set<string>;
  // Whole rows, not just ids: the run-window gate reads each instance's own
  // max age and template, and each extractor's `maxAgeDays` mapping state.
  // Loaded once by the caller, above the per-profile loop.
  enabledInstances: readonly ProviderInstanceRow[];
  sourceConfigs: readonly SourceConfigRow[];
  /**
   * What a body-supplied source list MEANS for this profile.
   *
   * `override` (single run) — run exactly this list. That is the long-standing
   * contract, and what the per-source re-run button depends on.
   *
   * `filter` (a chain) — run this profile's OWN pins, minus anything not in the
   * list. A chain's profiles pin different sources, so overriding would make
   * every profile run the same set and hand a profile sources it never
   * selected; narrowing is the only reading that survives N profiles.
   */
  sourceSelectionMode: "override" | "filter";
  loadRegistry: () => Promise<ExtractorRegistry | null>;
}

type ResolveRunConfigResult =
  | { ok: true; config: Partial<PipelineConfig> }
  /**
   * This profile has nothing left to run because the chain's source filter
   * removed everything it pinned — not a misconfiguration, so the caller drops
   * the leg instead of failing. Only reachable in `filter` mode.
   */
  | { ok: true; config: null }
  | { ok: false; error: AppError };

/**
 * The location intent a run would use for one Profile.
 *
 * Extracted so anything that must predict what a run will do — the run-options
 * endpoint that drives the run menu — derives it from the same expression the
 * run itself does, rather than a copy that drifts.
 *
 * A remote-type profile has no search geography: the editor hides Country and
 * Cities, so the stored values (kept for when the flag is unticked) must not
 * leak into the run and seed a location-scoped source. Body overrides still
 * win for explicit API callers.
 */
function buildRunLocationIntent(
  profileConfig: ProfileConfig | null,
  body: Partial<RunBody> = {},
) {
  const isRemoteProfile = profileConfig?.remoteProfile === true;
  return createLocationIntent({
    selectedCountry:
      body.country ?? (isRemoteProfile ? "" : profileConfig?.searchCountry),
    cityLocations:
      body.cityLocations ??
      (isRemoteProfile
        ? []
        : profileConfig
          ? parseSearchCitiesSetting(profileConfig.searchCities)
          : undefined),
    // A remote-type profile IS the remote workplace type: the editor hides the
    // ticks, and sending anything else would disable the remote-only boards
    // or leave jobspy's native remote filter off.
    workplaceTypes:
      body.workplaceTypes ??
      (isRemoteProfile ? ["remote"] : profileConfig?.workplaceTypes),
    geoScope: body.searchScope ?? profileConfig?.locationSearchScope,
    matchStrictness:
      body.matchStrictness ?? profileConfig?.locationMatchStrictness,
    remoteProfile: profileConfig?.remoteProfile,
    remoteLocationBlocklist: profileConfig?.remoteLocationBlocklist,
  });
}

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
    enabledInstances,
    sourceConfigs,
    sourceSelectionMode,
    loadRegistry,
  } = args;
  const profileConfig = profile?.config ?? null;

  const resolvedSearchTerms = body.searchTerms ?? profileConfig?.searchTerms;
  const isRemoteProfile = profileConfig?.remoteProfile === true;
  // A remote-type profile never runs Apify provider instances (PI's call,
  // 2026-08-21: LinkedIn's forced AI search degraded the actors' remote
  // filters to keyword soup, so every instance would bill for rows that are
  // not remote at all). An explicit body list still wins — the
  // escape hatch exists only for direct API callers.
  const profilePinnedInstanceIds = isRemoteProfile
    ? []
    : profileConfig?.providerInstanceIds;
  const resolvedProviderInstanceIds =
    body.providerInstanceIds === undefined
      ? profilePinnedInstanceIds
      : sourceSelectionMode === "override"
        ? body.providerInstanceIds
        : (profilePinnedInstanceIds ?? []).filter((id) =>
            body.providerInstanceIds?.includes(id),
          );

  const locationIntent = buildRunLocationIntent(profileConfig, body);

  // Sources: a body list wins verbatim (including `[]` = "no built-in
  // extractors"). Otherwise expand the Search Profile's pinned extractor ids
  // to their platform ids via the registry. An empty pin set means NO
  // extractors — a tick means what it says, and there is no "empty = all"
  // fallback. No profile at all → undefined → discovery uses every enabled
  // extractor.
  let resolvedSources: ExtractorSourceId[] | undefined;
  if (body.sources !== undefined && sourceSelectionMode === "override") {
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
    // A chain's list narrows this profile's own pins. Applied AFTER the
    // expansion so a profile keeps whatever it selected and simply loses what
    // the user unticked.
    if (body.sources !== undefined && sourceSelectionMode === "filter") {
      const keep = new Set<string>(body.sources);
      resolvedSources = resolvedSources?.filter((source) => keep.has(source));
    }
  }

  // Location compatibility is profile-dependent (it reads the resolved intent),
  // unlike the unknown/disabled source checks the caller already ran. Only an
  // OVERRIDE is gated: a filter says "nothing outside this list", so an entry
  // this profile cannot run simply drops out, exactly as a profile-derived
  // source does. Gating it would let one profile's geography 400 a whole chain.
  if (
    sourceSelectionMode === "override" &&
    body.sources &&
    body.sources.length > 0
  ) {
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
    // A chain's filter emptying ONE leg is the user's own narrowing, not a
    // broken profile: the menu offers the union across profiles, so unticking
    // a source legitimately leaves the profiles that did not pin it with
    // nothing. The leg is dropped; the caller refuses only if every leg is.
    //
    // Gated on the profile having pinned SOMETHING: a profile that selects no
    // sources at all is broken however the request was scoped, and silently
    // dropping it would hide a misconfiguration the old 400 named. Either list
    // can do the emptying, so both are checked — an instance-only narrowing
    // empties a leg exactly the same way.
    const pinnedAnything =
      (profileConfig?.enabledSourceIds.length ?? 0) > 0 ||
      (profileConfig?.providerInstanceIds.length ?? 0) > 0;
    if (
      sourceSelectionMode === "filter" &&
      pinnedAnything &&
      (body.sources !== undefined || body.providerInstanceIds !== undefined)
    ) {
      return { ok: true, config: null };
    }
    // Name the remote exclusion when it is what emptied the run — the generic
    // "enable a source" copy would send the user hunting a Sources-page
    // problem that does not exist.
    const emptiedByRemoteExclusion =
      isRemoteProfile &&
      body.providerInstanceIds === undefined &&
      (profileConfig?.providerInstanceIds ?? []).some((id) =>
        enabledInstanceIds.has(id),
      );
    return {
      ok: false,
      error: badRequest(
        emptiedByRemoteExclusion && profile
          ? `The "${profile.name}" search profile is remote-type, so its Apify actors are excluded from runs. Select a built-in source in the search profile.`
          : profile
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

  // The window gate runs before anything starts, for every profile of a chain.
  // A violation fails the WHOLE request rather than skipping the source: a run
  // that quietly scraped its configured window on some sources and the
  // requested one on others is not a result anyone asked for. Deselecting the
  // offending source is the user's escape hatch.
  if (body.scrapeWindowDays !== undefined) {
    // Only load the registry when there is something to gate — the empty-pin
    // short-circuit above deliberately avoids it so an unavailable registry
    // cannot turn a "no sources selected" 400 into a 503.
    const registry =
      resolvedSources && resolvedSources.length > 0
        ? await loadRegistry()
        : null;
    if (resolvedSources && resolvedSources.length > 0 && !registry) {
      return { ok: false, error: registryUnavailable() };
    }
    const gatedInstances = enabledInstances.filter((instance) =>
      effectiveInstanceIds.includes(instance.id),
    );
    // Gate only what the run will ACTUALLY touch. `resolvedSources` is every
    // platform of every pinned manifest, which still includes ones disabled on
    // the Sources page and ones this profile's location setup rules out —
    // discovery drops both silently. Refusing a run over the ceiling of a
    // source that was never going to run is worse than not gating: the menu
    // greys such a source out, so there is no tick to clear and no way forward.
    const gatedSources = resolvedSources?.filter((source) => {
      const manifest = registry?.manifestBySource.get(source);
      if (!manifest || !enabledExtractorIds.has(manifest.id)) return false;
      return (
        planLocationSources({
          intent: locationIntent,
          sources: [source],
        }).compatibleSources.length > 0
      );
    });
    const violations = findRunWindowViolations({
      windowDays: body.scrapeWindowDays,
      profileMaxAgeDays: profileConfig?.scrapeMaxAgeDays,
      sources: gatedSources,
      registry,
      sourceConfigs,
      instances: gatedInstances,
    });
    if (violations.length > 0) {
      return {
        ok: false,
        error: badRequest(
          describeRunWindowViolations(body.scrapeWindowDays, violations),
          { windowDays: body.scrapeWindowDays, violations },
        ),
      };
    }
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
      scrapeWindowDays: body.scrapeWindowDays,
      // The scrape watermarks the "since last run" window reads and advances
      // are per-profile, so the flag is inert on a profile-less run.
      profileId: profile?.id,
      // An explicit window forces the narrowing OFF for this run rather than
      // narrowing on top of it. `??` (never `||`) so the run menu's explicit
      // `false` is honoured instead of falling through to the Profile's flag.
      scrapeSinceLastRun:
        body.scrapeWindowDays !== undefined
          ? false
          : (body.scrapeSinceLastRun ?? profileConfig?.scrapeSinceLastRun),
      blockedCompanyKeywords: profileConfig?.blockedCompanyKeywords,
      locationIntent,
      enableAutoTailoring: body.enableAutoTailoring,
      partial: body.partial,
      discoveryConcurrency: body.discoveryConcurrency,
    },
  };
}

const registryUnavailable = () =>
  serviceUnavailable(
    "Extractor registry is unavailable. Try again after fixing startup errors.",
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
    return ok(res, {
      profileIds: profiles.map((profile) => profile.id),
      sources: Array.from(merged.values()),
      capDays: profileCaps.length > 0 ? Math.min(...profileCaps) : null,
      // Only pre-press "since last run" when EVERY leg narrows; otherwise the
      // menu would claim a mode half the chain is not configured for.
      defaultSinceLastRun:
        profiles.length > 0 &&
        profiles.every((profile) => profile.config.scrapeSinceLastRun === true),
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
    // Kept as whole rows: the run-window gate needs each instance's own max age
    // and its template, and each extractor's `maxAgeDays` mapping state.
    const enabledInstances = await getEnabledProviderInstances();
    const enabledInstanceIds = new Set(enabledInstances.map((row) => row.id));
    const sourceConfigs = await getAllSourceConfigs();

    // Body-provided sources are validated here (unknown → 400, disabled → 400)
    // because they depend on the body alone, not on any profile — running them
    // per profile would produce N identical errors attributed to an arbitrary
    // profile. The location-compatibility check IS profile-dependent and lives
    // in `resolveProfileRunConfig`. Profile-derived sources are NOT gated —
    // discovery skips incompatible ones rather than failing the run.
    // A partial run re-runs rows off the banner, which can name a source
    // disabled since the run they came from. Those are skipped and reported
    // rather than failing the request — unless the skip empties every list
    // the request gave explicitly (see the gate below).
    const skipDisabled = body.partial === true;
    const skippedDisabledSources: string[] = [];
    let requestedSources = body.sources;
    let requestedInstanceIds = body.providerInstanceIds;

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
      if (disabledSources.length > 0 && !skipDisabled) {
        return fail(
          res,
          badRequest(
            `Requested sources are not enabled: ${disabledSources.join(", ")}`,
            { disabledSources },
          ),
        );
      }
      skippedDisabledSources.push(...disabledSources);
      requestedSources = body.sources.filter(
        (source) => !disabledSources.includes(source),
      );
    }

    if (body.providerInstanceIds && body.providerInstanceIds.length > 0) {
      const unknownInstanceIds = body.providerInstanceIds.filter(
        (id) => !enabledInstanceIds.has(id),
      );
      if (unknownInstanceIds.length > 0 && !skipDisabled) {
        return fail(
          res,
          badRequest(
            `Requested provider instances are not enabled or do not exist: ${unknownInstanceIds.join(", ")}`,
            { unknownInstanceIds },
          ),
        );
      }
      skippedDisabledSources.push(...unknownInstanceIds);
      requestedInstanceIds = body.providerInstanceIds.filter(
        (id) => !unknownInstanceIds.includes(id),
      );
    }

    // An OMITTED list means "all enabled", so only explicit lists the skip
    // emptied leave nothing to run.
    if (
      skippedDisabledSources.length > 0 &&
      requestedSources?.length === 0 &&
      requestedInstanceIds?.length === 0
    ) {
      return fail(
        res,
        badRequest(
          `Requested sources are not enabled or do not exist: ${skippedDisabledSources.join(", ")}`,
          { skippedDisabledSources },
        ),
      );
    }

    // Multi-profile: resolve EVERY profile before starting anything, so a
    // broken profile late in the list fails the whole request instead of being
    // discovered after earlier profiles have already scraped.
    if (body.profileIds) {
      const entries: ProfileSequenceEntry[] = [];
      const skippedProfiles: string[] = [];
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
          enabledInstances,
          sourceConfigs,
          sourceSelectionMode: "filter",
          loadRegistry,
        });
        if (!resolved.ok) {
          return fail(res, resolved.error);
        }
        // `null` means the source filter left this profile nothing to run, so
        // it is dropped rather than failing the chain around it. Named in the
        // response: a leg vanishing from a chain with no signal is exactly the
        // silence this whole surface exists to remove.
        if (resolved.config === null) {
          skippedProfiles.push(profile.name);
          continue;
        }
        entries.push({
          profile: { id: profile.id, name: profile.name },
          config: resolved.config,
        });
      }

      if (entries.length === 0) {
        return fail(
          res,
          badRequest(
            "The selected sources leave nothing to run for any of these search profiles.",
          ),
        );
      }

      runWithRequestContext({}, () => {
        runProfileSequence(entries, { trigger: runTrigger }).catch((error) => {
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
        skippedProfiles,
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
      body: {
        ...body,
        sources: requestedSources,
        providerInstanceIds: requestedInstanceIds,
      },
      profile,
      enabledExtractorIds,
      enabledInstanceIds,
      enabledInstances,
      sourceConfigs,
      sourceSelectionMode: "override",
      loadRegistry,
    });
    if (!resolved.ok) {
      return fail(res, resolved.error);
    }
    if (resolved.config === null) {
      // Unreachable: only `filter` mode empties a leg into `null`, and this
      // path always overrides. Narrowed rather than asserted away so the type
      // stays honest if the modes ever change.
      return fail(res, badRequest("No sources are selected for this run."));
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
      runPipeline(resolved.config, { trigger: runTrigger })
        .catch((error) => {
          logger.error("Background pipeline run failed", error);
        })
        // Chained onto the CAUGHT promise, so it never rejects: an uncaught
        // `.finally` here would be an unhandled rejection on a failing run.
        .finally(() => {
          if (pageScoped) clearProfileRunPageTarget();
        });
    });
    ok(res, { message: "Pipeline started", skippedDisabledSources });
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
