/**
 * Turning a run request into the pipeline config(s) it will actually run.
 *
 * Lifted verbatim out of `api/routes/pipeline.ts` so the run route and the
 * scheduler share ONE derivation rather than two that drift. Everything here is
 * async request work: the request-shape guards, the pipeline/sequence claims and
 * the start calls stay with the caller, because the sequence claim has to be
 * taken synchronously before the first await and only the caller knows what to
 * do with the result.
 */

import {
  type AppError,
  badRequest,
  notFound,
  serviceUnavailable,
} from "@infra/errors";
import { logger } from "@infra/logger";
import {
  type ExtractorRegistry,
  getExtractorRegistry,
} from "@server/extractors/registry";
import type { ProfileSequenceEntry } from "@server/pipeline/index";
import { getProfile } from "@server/repositories/profiles";
import { getEnabledProviderInstances } from "@server/repositories/provider-instances";
import {
  getAllSourceConfigs,
  getEnabledExtractorIds,
} from "@server/repositories/source-configs";
import { getDefaultProfile } from "@server/services/profiles";
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
  type Profile,
  type ProfileConfig,
  type ProviderInstanceRow,
  type SourceConfigRow,
  SUITABILITY_CATEGORIES,
} from "@shared/types";
import { z } from "zod";
import {
  describeRunWindowViolations,
  findRunWindowViolations,
} from "./run-window";

const WORKPLACE_TYPE_VALUES = ["remote", "hybrid", "onsite"] as const;

export const runPipelineSchema = z.object({
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
  // Per-run override of the `liveStatusRefreshEnabled` setting. Absent falls
  // through to the setting; a `partial` run ignores both (see runPipeline).
  refreshLiveStatus: z.boolean().optional(),
  // Resolve the run's scrape config from this Profile. Body fields still win
  // per-field (one-off overrides); absent → the default Profile.
  profileId: z.string().min(1).optional(),
  // Run several Profiles one after another. Deliberately no `.max()`: the count
  // is bounded by how many Profiles exist, and an invented ceiling would be a
  // magic number. Callers must refuse combining it with `profileId` or
  // `partial` — the run route does so before calling, and `assembleRun` does
  // not re-check. `sources` / `providerInstanceIds` ARE allowed:
  // across a chain they narrow each profile's own selection, never replace it.
  profileIds: z.array(z.string().min(1)).min(1).optional(),
});

export type RunBody = z.infer<typeof runPipelineSchema>;

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
export function buildRunLocationIntent(
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
      // Not profile-backed: the live-status queue is the whole database, not
      // this Profile's slice of it, so there is nothing per-Profile to fall
      // back to. Absent here means "use the standing setting".
      refreshLiveStatus: body.refreshLiveStatus,
      partial: body.partial,
      discoveryConcurrency: body.discoveryConcurrency,
    },
  };
}

export const registryUnavailable = () =>
  serviceUnavailable(
    "Extractor registry is unavailable. Try again after fixing startup errors.",
  );

/**
 * What a run request resolves to.
 *
 * Two `ok: true` shapes rather than one list of sequence entries: a single run
 * may have NO profile at all (a pre-seed install with no default Profile), and
 * `ProfileSequenceEntry` requires one — so a single run is genuinely not
 * expressible as a one-entry sequence. The caller also starts them differently.
 */
export type AssembledRun =
  | { ok: false; error: AppError }
  | {
      ok: true;
      kind: "sequence";
      entries: ProfileSequenceEntry[];
      skippedProfiles: string[];
      skippedDisabledSources: string[];
    }
  | {
      ok: true;
      kind: "single";
      config: Partial<PipelineConfig>;
      skippedDisabledSources: string[];
    };

const err = (error: AppError): AssembledRun => ({ ok: false, error });

/**
 * Resolve a run request into the config(s) it will run, or the error that
 * should refuse it.
 *
 * The caller keeps every guard that must happen synchronously (the sequence
 * claim) or that describes the request rather than the run (the zod parse, the
 * window contradiction, the `profileIds` conflicts). Everything below is async
 * work against the DB and the extractor registry.
 *
 * `logRoute` names the caller in the registry-failure log; it exists so the
 * scheduler does not report itself as the HTTP route.
 */
export async function assembleRun(
  body: RunBody,
  options: {
    logRoute?: string;
    /**
     * Drop sources and provider instances that are no longer enabled instead of
     * refusing the request over them, reporting them in `skippedDisabledSources`.
     * Decoupled from `partial` on purpose: `partial` ALSO makes the run
     * reconcile into an existing banner funnel, which a scheduled run must not
     * do.
     */
    skipDisabledSources?: boolean;
  } = {},
): Promise<AssembledRun> {
  const logRoute = options.logRoute ?? "/api/pipeline/run";

  // Created PER CALL, deliberately, for `registryFailed`: hoisting this to
  // module scope would turn one transient registry failure into a process-wide
  // latch that 503s every run until a restart. (The cached REGISTRY itself is
  // not the reason — `initializeExtractorRegistry` already holds one for the
  // life of the process, so a module-scope cache here would pin the same
  // object and cost nothing in freshness.)
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
        route: logRoute,
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
  // A per-source re-run names rows off the banner, which can include a source
  // disabled since that run — those are skipped and reported rather than
  // refused. The scheduler opts in for the same reason from the other end: its
  // stored source list is months old by the time it fires, and one source
  // disabled on the Sources page since must not fail the whole nightly run.
  const skipDisabled =
    body.partial === true || options.skipDisabledSources === true;
  const skippedDisabledSources: string[] = [];
  let requestedSources = body.sources;
  let requestedInstanceIds = body.providerInstanceIds;

  if (body.sources && body.sources.length > 0) {
    const registry = await loadRegistry();
    if (!registry) {
      return err(registryUnavailable());
    }
    const unavailableSources = body.sources.filter(
      (source) => !registry.manifestBySource.has(source),
    );
    if (unavailableSources.length > 0) {
      return err(
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
      return err(
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
      return err(
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
    return err(
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
        return err(notFound(`Profile not found: ${profileId}`));
      }
      // The chain passes the body's RAW lists where the single path below
      // passes the skip-filtered ones. Kept different on purpose, and NOT
      // because the two are always equal: the skip is `body.partial === true`,
      // and refusing `partial` alongside `profileIds` is the CALLER's
      // obligation (the run route does it before calling), not something this
      // module enforces. A caller that sent both would reach here with the two
      // lists genuinely different, so unifying them would change what such a
      // caller runs.
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
        return err(resolved.error);
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
      return err(
        badRequest(
          "The selected sources leave nothing to run for any of these search profiles.",
        ),
      );
    }

    return {
      ok: true,
      kind: "sequence",
      entries,
      skippedProfiles,
      skippedDisabledSources,
    };
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
      return err(notFound(`Profile not found: ${body.profileId}`));
    }
  } else {
    profile = await getDefaultProfile();
  }

  // Skip-filtered lists here; the chain above passes the raw ones (see there).
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
    return err(resolved.error);
  }
  if (resolved.config === null) {
    // Unreachable: only `filter` mode empties a leg into `null`, and this
    // path always overrides. Narrowed rather than asserted away so the type
    // stays honest if the modes ever change.
    return err(badRequest("No sources are selected for this run."));
  }

  return {
    ok: true,
    kind: "single",
    config: resolved.config,
    skippedDisabledSources,
  };
}
