import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { getExtractorRegistry } from "@server/extractors/registry";
import { getProvider } from "@server/providers";
import type { ProviderRunner } from "@server/providers/types";
import { getAllJobUrls } from "@server/repositories/jobs";
import * as providerInstancesRepo from "@server/repositories/provider-instances";
import * as settingsRepo from "@server/repositories/settings";
import * as sourceConfigsRepo from "@server/repositories/source-configs";
import { getScrapeWatermarks } from "@server/repositories/source-scrape-watermarks";
import { getEffectiveSettings } from "@server/services/settings";
import { resolveSourceContextSettings } from "@server/services/source-configs/resolve";
import { asyncPool } from "@server/utils/async-pool";
import type { ExtractorSourceId } from "@shared/extractors";
import {
  describeLocationRejection,
  matchJobLocationIntent,
} from "@shared/job-matching.js";
import {
  buildLocationEvidence as buildSharedLocationEvidence,
  createLocationIntentFromLegacyInputs,
  getPrimaryLocationLabel,
  planLocationSource,
} from "@shared/location-domain.js";
import { formatCountryLabel } from "@shared/location-support.js";
import {
  bucketWindowDays,
  resolveScrapeWindowDays,
  type ScrapedSourceMark,
} from "@shared/scrape-window.js";
import { serializeSearchCitiesSetting } from "@shared/search-cities.js";
import type {
  CapturedRunJob,
  CreateJobInput,
  PipelineConfig,
  ProviderInstanceRow,
  SourceConfigRow,
  SourceConfigRunGlobals,
  SourceConfigSchema,
} from "@shared/types";
import { type CrawlSource, progressHelpers, updateProgress } from "../progress";
import { captureRunJobs, toCapturedRunJob } from "../run-job-capture";

type DiscoveryTaskResult = {
  discoveredJobs: CreateJobInput[];
  sourceErrors: string[];
  /**
   * Items the source returned that its mapper could not read. Named apart from
   * the `droppedCount` locals further down, which count something else
   * entirely (location-intent mismatch / blocked employer).
   */
  unmappableCount: number;
};

type DiscoverySourceTask = {
  source: CrawlSource;
  platforms: string[];
  termsTotal?: number;
  detail: string;
  // Display label override for the source-stats row. Provider instances pass
  // their user-set name so the pipeline table shows it instead of the raw
  // `<provider>:<uuid>` synthetic id.
  label?: string;
  /**
   * The window this task actually runs with, in days — the run override when
   * one applies, else the configured cap, else null when nothing bounds it.
   * Carried on the task so the watermark write can tell whether the run
   * covered the gap since the last one; see `resolveWatermarkAdvance`.
   */
  effectiveWindowDays: number | null;
  /** The standing max job age for this source; see `ScrapedSourceMark`. */
  policyWindowDays: number | null;
  run: () => Promise<DiscoveryTaskResult>;
};

function isBlockedEmployer(
  employer: string | null | undefined,
  blockedKeywordsLowerCase: string[],
): boolean {
  if (!employer) return false;
  if (blockedKeywordsLowerCase.length === 0) return false;
  const normalizedEmployer = employer.toLowerCase();
  return blockedKeywordsLowerCase.some((keyword) =>
    normalizedEmployer.includes(keyword),
  );
}

function getLegacyLocationSelection(
  intent: NonNullable<PipelineConfig["locationIntent"]>,
): string {
  return intent.selectedCountry ?? "";
}

function getSourceLocationPlan(
  source: CrawlSource,
  intent: NonNullable<PipelineConfig["locationIntent"]>,
): ReturnType<typeof planLocationSource> & {
  canRun: boolean;
  warnings: string[];
} {
  const plan = planLocationSource({ source, intent });
  return {
    ...plan,
    canRun: plan.isCompatible,
    warnings: plan.reasons,
  };
}

function buildLocationEvidence(args: {
  location?: string | null;
  isRemote?: boolean | null;
  sourceNotes?: readonly string[] | null;
}): CreateJobInput["locationEvidence"] {
  if (!args.location && args.isRemote !== true) return undefined;
  return buildSharedLocationEvidence({
    location: args.location ?? (args.isRemote ? "Remote" : null),
    isRemote: args.isRemote ?? null,
    source:
      args.sourceNotes?.find((note) => note.startsWith("source:"))?.slice(7) ??
      null,
  });
}

export async function discoverJobsStep(args: {
  mergedConfig: PipelineConfig;
  shouldCancel?: () => boolean;
}): Promise<{
  discoveredJobs: CreateJobInput[];
  sourceErrors: string[];
  /**
   * Sources that scraped without error this run, each with the window it ran
   * with, and the timestamp their watermark should be measured against. The
   * caller advances the watermarks once the jobs are imported — see
   * `recordScrapeWatermarks`.
   */
  scrapedSources: ScrapedSourceMark[];
  scrapeStartedAt: string;
}> {
  logger.info("Running discovery step");

  const discoveredJobs: CreateJobInput[] = [];
  const sourceErrors: string[] = [];
  // Taken before any source runs: a watermark must never be later than the
  // request it stands for, or the next run's window starts after postings the
  // previous run had not yet seen.
  const scrapeStartedAt = new Date().toISOString();
  const scrapedSources: ScrapedSourceMark[] = [];

  const registry = await getExtractorRegistry();

  // Prefer the Profile-driven config; fall back to the env default so direct
  // callers without a config still run.
  let searchTerms: string[];
  if (args.mergedConfig.searchTerms !== undefined) {
    searchTerms = args.mergedConfig.searchTerms;
  } else {
    const defaultSearchTermsEnv =
      process.env.JOBSPY_SEARCH_TERMS || "web developer";
    searchTerms = defaultSearchTermsEnv
      .split("|")
      .map((term) => term.trim())
      .filter(Boolean);
  }

  const locationIntent =
    args.mergedConfig.locationIntent ??
    createLocationIntentFromLegacyInputs({});

  const sourceConfigRows = await sourceConfigsRepo.getAllSourceConfigs();
  const sourceConfigByExtractor = new Map<string, SourceConfigRow>();
  for (const row of sourceConfigRows) {
    sourceConfigByExtractor.set(row.extractorId, row);
  }
  const enabledExtractorIds = new Set<string>(
    sourceConfigRows.filter((row) => row.enabled).map((row) => row.extractorId),
  );

  // When `sources` is undefined the caller wants "all platforms whose
  // extractor is enabled in source_configs". When specified, the caller's
  // list is authoritative — downstream code (per-extractor grouping) drops
  // platforms whose extractor isn't enabled.
  const allEnabledPlatforms: ExtractorSourceId[] = Array.from(
    registry.manifestBySource.entries(),
  )
    .filter(([, manifest]) => enabledExtractorIds.has(manifest.id))
    .map(([platform]) => platform);

  const requestedSources: ExtractorSourceId[] =
    args.mergedConfig.sources === undefined
      ? allEnabledPlatforms
      : args.mergedConfig.sources;

  const runGlobals: SourceConfigRunGlobals = {
    // Derived from locationIntent (Profile-driven via the run config) so a
    // run's location is atomic.
    city: serializeSearchCitiesSetting(locationIntent.cityLocations) ?? "",
    country: locationIntent.selectedCountry ?? "",
    workplaceTypes: JSON.stringify(locationIntent.workplaceTypes),
    ...(args.mergedConfig.maxJobsPerTerm !== undefined
      ? { maxJobsPerTerm: String(args.mergedConfig.maxJobsPerTerm) }
      : {}),
    // Max-age comes from the Profile-driven config. null/undefined = unset →
    // no key → each extractor keeps its own default.
    ...(args.mergedConfig.scrapeMaxAgeDays !== undefined &&
    args.mergedConfig.scrapeMaxAgeDays !== null
      ? { maxAgeDays: String(args.mergedConfig.scrapeMaxAgeDays) }
      : {}),
  };

  // "Scrape since the last run": each source's max-age window narrows to the
  // days elapsed since it last scraped successfully for this Profile. Only
  // ever narrower than the configured cap, so a source with no watermark (new
  // source, cleared profile, first run) simply keeps the configured window.
  const watermarkProfileId =
    args.mergedConfig.scrapeSinceLastRun === true
      ? args.mergedConfig.profileId
      : undefined;
  const scrapeWatermarks = watermarkProfileId
    ? await getScrapeWatermarks(watermarkProfileId)
    : new Map<string, string>();
  const scrapeWindowNow = Date.parse(scrapeStartedAt);

  /**
   * Effective max job age for one source, or null to leave the configured
   * window alone. `capDays` is what that source would otherwise use — the
   * Profile's cap, or a provider instance's own override.
   */
  const scrapeWindowFor = (
    sourceKey: string,
    capDays: number | null | undefined,
  ): number | null => {
    // An explicit per-run window wins over the watermark narrowing: the user
    // asked for exactly this span, and the run route has already refused it if
    // it exceeded the cap. Still min-ed against the cap so the function stays
    // total for any caller that reaches it without the gate.
    const requested = args.mergedConfig.scrapeWindowDays;
    if (typeof requested === "number" && requested > 0) {
      return typeof capDays === "number" && capDays > 0
        ? Math.min(requested, Math.floor(capDays))
        : requested;
    }
    return watermarkProfileId
      ? resolveScrapeWindowDays({
          lastScrapedAt: scrapeWatermarks.get(sourceKey),
          now: scrapeWindowNow,
          capDays,
        })
      : null;
  };

  const runGlobalsFor = (windowDays: number | null): SourceConfigRunGlobals =>
    windowDays === null
      ? runGlobals
      : { ...runGlobals, maxAgeDays: String(windowDays) };

  /**
   * The `max_age_days` a source resolved to, read back out of the settings the
   * source is actually handed rather than re-derived from the run's cap.
   *
   * That distinction is load-bearing: `resolveSourceContextSettings` applies the
   * per-source config BEFORE the global-mapping loop, so an extractor whose
   * `maxAgeDays` mapping is unticked honours its OWN stored value and ignores
   * the run entirely. Reporting the run's cap for such a source would claim
   * coverage it never had.
   *
   * `Infinity` for a manifest with no max-age concept at all (it returns its
   * whole feed, so it covers any gap); `null` when the field exists but is
   * blank, i.e. the extractor fell back to a default this layer cannot see.
   */
  const extractorWindowFrom = (
    manifest: { configSchema?: SourceConfigSchema },
    settings: Record<string, string>,
  ): number | null => {
    const mapping = manifest.configSchema?.globalMappings.find(
      (candidate) => candidate.globalField === "maxAgeDays",
    );
    const fieldKey = mapping?.sourceField ?? "max_age_days";
    const hasMaxAgeConcept =
      mapping !== undefined ||
      manifest.configSchema?.fields.some((field) => field.key === fieldKey) ===
        true;
    if (!hasMaxAgeConcept) return Number.POSITIVE_INFINITY;

    const parsed = Number.parseInt(settings[fieldKey] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  /**
   * The window a provider instance actually ran with. An actor that expresses
   * recency as a fixed set of windows silently snaps the request onto them —
   * upwards below its widest entry, and DOWNWARDS above it — so the requested
   * value is not what it covered.
   */
  const instanceWindowFrom = (
    provider: ProviderRunner,
    instance: ProviderInstanceRow,
    requestedDays: number | null,
  ): number | null => {
    if (requestedDays === null) return null;
    const buckets = instance.templateId
      ? provider.templates.find(
          (template) => template.id === instance.templateId,
        )?.maxAgeBuckets
      : undefined;
    return buckets && buckets.length > 0
      ? bucketWindowDays(requestedDays, buckets)
      : requestedDays;
  };

  /**
   * What a source was asked for: the run's override when one applies, else the
   * cap it would otherwise use. Null when nothing bounds it at all.
   *
   * Takes the ALREADY-COMPUTED override rather than re-deriving it, so the
   * value the mark describes cannot drift from the value the source was handed.
   */
  const requestedWindow = (
    appliedDays: number | null,
    capDays: number | null | undefined,
  ): number | null => {
    if (appliedDays !== null) return appliedDays;
    return typeof capDays === "number" &&
      Number.isFinite(capDays) &&
      capDays > 0
      ? Math.floor(capDays)
      : null;
  };

  const sourcePlans = requestedSources.map((source) => ({
    source,
    plan: getSourceLocationPlan(source, locationIntent),
  }));
  const compatibleSources: ExtractorSourceId[] = sourcePlans
    .filter(({ plan }) => plan.canRun)
    .map(({ source }) => source);
  let existingJobUrlsPromise: Promise<string[]> | null = null;
  const getExistingJobUrls = (): Promise<string[]> => {
    if (!existingJobUrlsPromise) {
      existingJobUrlsPromise = getAllJobUrls();
    }
    return existingJobUrlsPromise;
  };
  const skippedSources = sourcePlans.filter(({ plan }) => !plan.canRun);

  if (skippedSources.length > 0) {
    logger.info("Skipping incompatible sources for requested location intent", {
      step: "discover-jobs",
      locationIntent,
      primaryLocation: getPrimaryLocationLabel(locationIntent),
      requestedSources,
      skippedSources: skippedSources.map(({ source }) => source),
      warnings: skippedSources.flatMap(({ plan }) => plan.warnings),
    });
  }

  if (requestedSources.length > 0 && compatibleSources.length === 0) {
    // Name the remote gate when it is what emptied the run: a remote-only
    // board skipped on a non-remote profile would otherwise surface as a
    // country problem that does not exist.
    const remoteGated = sourcePlans
      .filter(
        ({ plan }) =>
          !plan.canRun &&
          plan.capabilities.requiresRemoteProfile &&
          !locationIntent.remoteProfile,
      )
      .map(({ source }) => source);
    // Same for the country-or-city requirement: a remote profile sends no
    // geography, so a source that needs some is skipped, not empty.
    const geographyGated = sourcePlans
      .filter(
        ({ plan }) =>
          !plan.canRun &&
          plan.capabilities.requiresCountry &&
          !locationIntent.selectedCountry &&
          locationIntent.cityLocations.length === 0,
      )
      .map(({ source }) => source);
    const refusals = [
      ...(remoteGated.length > 0
        ? [`${remoteGated.join(", ")}: runs only on a remote-type profile`]
        : []),
      ...(geographyGated.length > 0
        ? [`${geographyGated.join(", ")}: needs a selected country or city`]
        : []),
    ];
    const refusalSuffix =
      refusals.length > 0 ? ` (${refusals.join("; ")})` : "";
    throw new Error(
      locationIntent.selectedCountry
        ? `No compatible sources for selected country: ${formatCountryLabel(locationIntent.selectedCountry)}${refusalSuffix}`
        : `No compatible sources for requested location: ${getPrimaryLocationLabel(locationIntent)}${refusalSuffix}`,
    );
  }

  const groupedByManifest = new Map<
    string,
    { sources: string[]; detail: string; termsTotal?: number }
  >();

  for (const source of compatibleSources) {
    const manifest = registry.manifestBySource.get(source);
    if (!manifest) {
      sourceErrors.push(`${source}: extractor manifest not registered`);
      continue;
    }

    if (!enabledExtractorIds.has(manifest.id)) continue;

    const existing = groupedByManifest.get(manifest.id);
    if (existing) {
      existing.sources.push(source);
      continue;
    }

    groupedByManifest.set(manifest.id, {
      sources: [source],
      termsTotal: searchTerms.length,
      detail: `${manifest.displayName}: fetching jobs...`,
    });
  }

  const sourceTasks: DiscoverySourceTask[] = [];

  // Provider-instance tasks (Apify and future marketplace providers).
  // Each enabled instance is its own runnable with one synthetic platform
  // id `<providerId>:<instanceId>`. The instance carries its own input
  // template + output mapping; the API token lives in settings.
  const allEnabledProviderInstances =
    await providerInstancesRepo.getEnabledProviderInstances();
  // `providerInstanceIds === undefined` → run every enabled instance (default).
  // A list (incl. empty) → run only those ids. This lets a per-source re-run
  // scope to one instance, or to no instances when only an extractor re-runs.
  const requestedProviderInstanceIds = args.mergedConfig.providerInstanceIds;
  const enabledProviderInstances =
    requestedProviderInstanceIds === undefined
      ? allEnabledProviderInstances
      : allEnabledProviderInstances.filter((instance) =>
          requestedProviderInstanceIds.includes(instance.id),
        );
  if (enabledProviderInstances.length > 0) {
    const apifyApiToken =
      (await settingsRepo.getSetting("apifyApiToken")) ?? "";
    for (const instance of enabledProviderInstances) {
      const provider = getProvider(instance.providerId);
      if (!provider) {
        sourceErrors.push(
          `${instance.label}: provider "${instance.providerId}" is not registered`,
        );
        continue;
      }
      const apiToken = instance.providerId === "apify" ? apifyApiToken : "";
      const syntheticSource = `${instance.providerId}:${instance.id}`;
      // A per-instance max age wins over the Profile's cap, so it is the cap
      // the window narrows against. The narrowed value is written back onto
      // both the instance and the run globals: `resolveMaxAgeDays` and the
      // `{{maxAgeDays}}` placeholder both read the instance first.
      // One expression for the cap, reused by the override, the mark and the
      // policy it is judged against — three readings of the same number.
      const instanceCapDays =
        instance.maxAgeDays ?? args.mergedConfig.scrapeMaxAgeDays ?? null;
      const instanceWindow = scrapeWindowFor(syntheticSource, instanceCapDays);
      const effectiveInstance =
        instanceWindow === null
          ? instance
          : { ...instance, maxAgeDays: instanceWindow };
      const instanceRunGlobals = runGlobalsFor(instanceWindow);
      sourceTasks.push({
        source: syntheticSource,
        platforms: [syntheticSource],
        termsTotal: searchTerms.length,
        detail: `${instance.label}: fetching jobs...`,
        label: instance.label,
        effectiveWindowDays: instanceWindowFrom(
          provider,
          instance,
          requestedWindow(instanceWindow, instanceCapDays),
        ),
        policyWindowDays: instanceCapDays,
        run: async () => {
          const result = await provider.run({
            instance: effectiveInstance,
            runGlobals: instanceRunGlobals,
            apiToken: apiToken || null,
            searchTerms,
            shouldCancel: args.shouldCancel,
            onProgress: (event) => {
              progressHelpers.crawlingUpdate({
                source: syntheticSource,
                termsProcessed: event.termsProcessed,
                termsTotal: event.termsTotal,
                listPagesProcessed: event.listPagesProcessed,
                listPagesTotal: event.listPagesTotal,
                jobCardsFound: event.jobCardsFound,
                jobPagesEnqueued: event.jobPagesEnqueued,
                jobPagesSkipped: event.jobPagesSkipped,
                jobPagesProcessed: event.jobPagesProcessed,
                phase: event.phase,
                currentUrl: event.currentUrl,
              });
              if (event.detail) {
                updateProgress({ step: "crawling", detail: event.detail });
              }
            },
          });

          if (!result.success) {
            return {
              // A failed run can still carry salvaged rows (an Apify run
              // that timed out mid-crawl); they import like any others.
              discoveredJobs: result.jobs,
              sourceErrors: [
                `${instance.label}: ${result.error ?? "unknown error"}`,
              ],
              unmappableCount: result.droppedCount ?? 0,
            };
          }
          return {
            discoveredJobs: result.jobs,
            sourceErrors: [],
            unmappableCount: result.droppedCount ?? 0,
          };
        },
      });
    }
  }

  for (const [manifestId, grouped] of groupedByManifest) {
    const manifest = registry.manifests.get(manifestId);
    if (!manifest) continue;

    // Resolved here rather than inside `run()` so the task can carry the window
    // it ran with. Every input is fixed before any task starts, so the values
    // are identical to resolving them lazily.
    const extractorWindow = scrapeWindowFor(
      manifest.id,
      args.mergedConfig.scrapeMaxAgeDays,
    );
    const extractorRow = sourceConfigByExtractor.get(manifest.id);
    const extractorSettings = resolveSourceContextSettings({
      schema: manifest.configSchema,
      row: extractorRow ?? { config: {}, mappings: {} },
      runGlobals: runGlobalsFor(extractorWindow),
    });
    sourceTasks.push({
      source: manifest.id,
      platforms: [...grouped.sources],
      termsTotal: grouped.termsTotal,
      detail:
        grouped.sources.length > 1
          ? `${manifest.displayName}: ${grouped.sources.join(", ")}...`
          : grouped.detail,
      effectiveWindowDays: extractorWindowFrom(manifest, extractorSettings),
      policyWindowDays: args.mergedConfig.scrapeMaxAgeDays ?? null,
      run: async () => {
        const perSourceSettings = extractorSettings;

        const result = await manifest.run({
          source: grouped.sources[0],
          selectedSources: grouped.sources,
          settings: perSourceSettings,
          searchTerms,
          selectedCountry: getLegacyLocationSelection(locationIntent),
          locationIntent,
          sourceLocationPlan: getSourceLocationPlan(
            grouped.sources[0] as CrawlSource,
            locationIntent,
          ),
          getExistingJobUrls,
          shouldCancel: args.shouldCancel,
          onProgress: (event) => {
            progressHelpers.crawlingUpdate({
              source: manifest.id,
              termsProcessed: event.termsProcessed,
              termsTotal: event.termsTotal,
              listPagesProcessed: event.listPagesProcessed,
              listPagesTotal: event.listPagesTotal,
              jobCardsFound: event.jobCardsFound,
              jobPagesEnqueued: event.jobPagesEnqueued,
              jobPagesSkipped: event.jobPagesSkipped,
              jobPagesProcessed: event.jobPagesProcessed,
              phase: event.phase,
              currentUrl: event.currentUrl,
            });

            if (event.detail) {
              updateProgress({
                step: "crawling",
                detail: event.detail,
              });
            }
          },
        });

        if (!result.success) {
          return {
            // Same salvage contract as provider instances: rows a failed run
            // returned are kept, the failure still marks the source failed.
            discoveredJobs: result.jobs,
            sourceErrors: [
              `${manifest.displayName || manifest.id}: ${result.error ?? "unknown error"} (sources: ${grouped.sources.join(",")})`,
            ],
            unmappableCount: result.droppedCount ?? 0,
          };
        }

        return {
          discoveredJobs: result.jobs,
          sourceErrors: [],
          unmappableCount: result.droppedCount ?? 0,
        };
      },
    });
  }

  const totalSources = sourceTasks.length;
  let completedSources = 0;

  progressHelpers.startCrawling(totalSources, {
    preserveSourceStats: args.mergedConfig.partial === true,
  });

  if (args.shouldCancel?.()) {
    return { discoveredJobs, sourceErrors, scrapedSources, scrapeStartedAt };
  }

  const discoveryConcurrency =
    args.mergedConfig.discoveryConcurrency ??
    (await getEffectiveSettings()).discoveryConcurrency.value;

  const sourceResults = await asyncPool<
    DiscoverySourceTask,
    DiscoveryTaskResult
  >({
    items: sourceTasks,
    concurrency: discoveryConcurrency,
    shouldStop: args.shouldCancel,
    onTaskStarted: (sourceTask) => {
      progressHelpers.startSource(
        sourceTask.source,
        completedSources,
        totalSources,
        {
          termsTotal: sourceTask.termsTotal,
          detail: sourceTask.detail,
          platforms: sourceTask.platforms,
          label: sourceTask.label,
        },
      );
    },
    onTaskSettled: (sourceTask, _index, outcome) => {
      completedSources += 1;
      progressHelpers.completeSource(completedSources, totalSources);

      if (outcome.status !== "fulfilled") {
        const message =
          outcome.error instanceof Error
            ? outcome.error.message
            : "unknown error";
        for (const platform of sourceTask.platforms) {
          progressHelpers.markSourceFailed(platform, message);
        }
        return;
      }

      const taskResult = outcome.result;
      if (taskResult.sourceErrors.length > 0) {
        const message = taskResult.sourceErrors.join("; ");
        // Salvaged rows still count and capture — recorded BEFORE the failed
        // mark so the funnel shows what the dying run paid for. The watermark
        // does NOT advance (below): the run did not cover its window.
        for (const platform of sourceTask.platforms) {
          const platformJobs = taskResult.discoveredJobs.filter(
            (job) => job.source === platform,
          );
          // Unconditional, like the success branch: a dying run that scraped
          // items it could not map still shows its unmappable count.
          progressHelpers.recordSourceJobsCounts(platform, {
            scraped: platformJobs.length,
            unmappable:
              platform === sourceTask.platforms[0]
                ? taskResult.unmappableCount
                : 0,
          });
          captureRunJobs(
            platform,
            "scraped",
            platformJobs.map((job) => toCapturedRunJob(job)),
          );
          progressHelpers.markSourceFailed(platform, message);
        }
        return;
      }

      // Errorless completion is what advances the watermark, keyed on the task
      // (one extractor manifest or one provider instance) rather than the
      // platform ids it fans out to — that is the granularity the next run
      // resolves its window at. A failed source keeps its old watermark, so
      // its next window reaches back over everything it missed.
      scrapedSources.push({
        sourceKey: sourceTask.source,
        windowDays: sourceTask.effectiveWindowDays,
        policyWindowDays: sourceTask.policyWindowDays,
      });

      for (const platform of sourceTask.platforms) {
        const platformJobs = taskResult.discoveredJobs.filter(
          (job) => job.source === platform,
        );
        progressHelpers.recordSourceJobsCounts(platform, {
          scraped: platformJobs.length,
          // One task reports ONE count, and a fan-out task's unreadable rows
          // usually cannot say which platform they belonged to — jobspy's
          // unrecognised-`site` rows are exactly that. So the count lands once,
          // on the task's first platform, rather than being duplicated across
          // siblings (which would triple it) or split into invented precision.
          // For every single-platform source it is simply that source's count.
          unmappable:
            platform === sourceTask.platforms[0]
              ? taskResult.unmappableCount
              : 0,
        });
        captureRunJobs(
          platform,
          "scraped",
          platformJobs.map((job) => toCapturedRunJob(job)),
        );
        progressHelpers.markSourceCompleted(platform);
      }
    },
    task: async (sourceTask) => {
      try {
        return await sourceTask.run();
      } catch (error) {
        logger.warn("Discovery source task failed", {
          sourceTask: sourceTask.source,
          error: sanitizeUnknown(error),
        });

        return {
          discoveredJobs: [],
          sourceErrors: [
            `${sourceTask.source}: ${error instanceof Error ? error.message : "unknown error"}`,
          ],
          unmappableCount: 0,
        };
      }
    },
  });

  for (const sourceResult of sourceResults) {
    discoveredJobs.push(...sourceResult.discoveredJobs);
    sourceErrors.push(...sourceResult.sourceErrors);
  }

  const locationFilterReasonCounts: Record<string, number> = {};
  // Which check failed, per job, so the banner's Rejected list can say so. The
  // reason has to be captured HERE — by the time the rows are attributed back
  // to their source the match result is gone, and "location mismatch" alone is
  // undiagnosable from the UI.
  const locationDropReasons = new Map<CreateJobInput, string>();
  const locationFilteredJobs = discoveredJobs.filter((job) => {
    const evidence =
      job.locationEvidence ??
      buildLocationEvidence({
        location: job.location,
        isRemote: job.isRemote,
        sourceNotes: [`source:${job.source}`],
      });
    job.locationEvidence = evidence;
    const match = matchJobLocationIntent(job, locationIntent);
    if (match.matched) {
      return true;
    }
    const reasonCode = match.reasonCode;
    locationFilterReasonCounts[reasonCode] =
      (locationFilterReasonCounts[reasonCode] ?? 0) + 1;
    locationDropReasons.set(
      job,
      describeLocationRejection(reasonCode, locationIntent),
    );
    return false;
  });
  const locationFilteredOutCount =
    discoveredJobs.length - locationFilteredJobs.length;

  if (locationFilteredOutCount > 0) {
    logger.info(
      "Dropped discovered jobs that did not satisfy location preferences",
      {
        step: "discover-jobs",
        droppedCount: locationFilteredOutCount,
        locationIntent,
        primaryLocation: getPrimaryLocationLabel(locationIntent),
        reasonCounts: locationFilterReasonCounts,
      },
    );
  }

  const blockedCompanyKeywords = args.mergedConfig.blockedCompanyKeywords ?? [];
  const blockedKeywordsLowerCase = blockedCompanyKeywords.map((value) =>
    value.toLowerCase(),
  );
  const filteredDiscoveredJobs = locationFilteredJobs.filter(
    (job) => !isBlockedEmployer(job.employer, blockedKeywordsLowerCase),
  );
  const droppedCount =
    locationFilteredJobs.length - filteredDiscoveredJobs.length;

  // Attribute every found-but-dropped job (location mismatch + blocked
  // company) back to its source so the banner's Rejected column reconciles
  // with Scraped, and capture the actual jobs (with reason) for the popup.
  // Import-time rejects (bad date) are recorded separately in import-jobs.
  const locationKept = new Set(locationFilteredJobs);
  const blockedKept = new Set(filteredDiscoveredJobs);
  const droppedBySource = new Map<string, CapturedRunJob[]>();
  for (const job of discoveredJobs) {
    if (blockedKept.has(job)) continue;
    const reason = locationKept.has(job)
      ? "blocked company"
      : (locationDropReasons.get(job) ?? "location mismatch");
    const list = droppedBySource.get(job.source) ?? [];
    list.push(toCapturedRunJob(job, reason));
    droppedBySource.set(job.source, list);
  }
  for (const [source, jobs] of droppedBySource) {
    captureRunJobs(source, "rejected", jobs);
    progressHelpers.recordSourceJobsFiltered(source, jobs.length);
  }

  if (droppedCount > 0) {
    const blockedCompanyKeywordsPreview = blockedCompanyKeywords.slice(0, 10);
    const blockedCompanyKeywordsTruncated =
      blockedCompanyKeywordsPreview.length < blockedCompanyKeywords.length;

    logger.info("Dropped discovered jobs matching blocked company keywords", {
      step: "discover-jobs",
      droppedCount,
      blockedKeywordCount: blockedCompanyKeywords.length,
      blockedCompanyKeywordsPreview,
      blockedCompanyKeywordsTruncated,
    });

    logger.debug("Full blocked company keywords used for filtering", {
      step: "discover-jobs",
      blockedCompanyKeywords,
    });
  }

  if (args.shouldCancel?.()) {
    return {
      discoveredJobs: filteredDiscoveredJobs,
      sourceErrors,
      scrapedSources,
      scrapeStartedAt,
    };
  }

  if (filteredDiscoveredJobs.length === 0 && sourceErrors.length > 0) {
    throw new Error(`All sources failed: ${sourceErrors.join("; ")}`);
  }

  if (sourceErrors.length > 0) {
    logger.warn("Some discovery sources failed", { sourceErrors });
  }

  progressHelpers.crawlingComplete(filteredDiscoveredJobs.length);

  return {
    discoveredJobs: filteredDiscoveredJobs,
    sourceErrors,
    scrapedSources,
    scrapeStartedAt,
  };
}
