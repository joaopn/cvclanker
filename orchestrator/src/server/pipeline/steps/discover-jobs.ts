import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { getExtractorRegistry } from "@server/extractors/registry";
import { getProvider } from "@server/providers";
import { getAllJobUrls } from "@server/repositories/jobs";
import * as providerInstancesRepo from "@server/repositories/provider-instances";
import * as settingsRepo from "@server/repositories/settings";
import * as sourceConfigsRepo from "@server/repositories/source-configs";
import { getEffectiveSettings } from "@server/services/settings";
import { resolveSourceContextSettings } from "@server/services/source-configs/resolve";
import { asyncPool } from "@server/utils/async-pool";
import type { ExtractorSourceId } from "@shared/extractors";
import { matchJobLocationIntent } from "@shared/job-matching.js";
import {
  buildLocationEvidence as buildSharedLocationEvidence,
  createLocationIntentFromLegacyInputs,
  getPrimaryLocationLabel,
  planLocationSource,
} from "@shared/location-domain.js";
import { formatCountryLabel } from "@shared/location-support.js";
import { serializeSearchCitiesSetting } from "@shared/search-cities.js";
import type {
  CapturedRunJob,
  CreateJobInput,
  PipelineConfig,
  SourceConfigRow,
  SourceConfigRunGlobals,
} from "@shared/types";
import { type CrawlSource, progressHelpers, updateProgress } from "../progress";
import { captureRunJobs, toCapturedRunJob } from "../run-job-capture";

type DiscoveryTaskResult = {
  discoveredJobs: CreateJobInput[];
  sourceErrors: string[];
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
}> {
  logger.info("Running discovery step");

  const discoveredJobs: CreateJobInput[] = [];
  const sourceErrors: string[] = [];

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
    throw new Error(
      locationIntent.selectedCountry
        ? `No compatible sources for selected country: ${formatCountryLabel(locationIntent.selectedCountry)}`
        : `No compatible sources for requested location: ${getPrimaryLocationLabel(locationIntent)}`,
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
      sourceTasks.push({
        source: syntheticSource,
        platforms: [syntheticSource],
        termsTotal: searchTerms.length,
        detail: `${instance.label}: fetching jobs...`,
        label: instance.label,
        run: async () => {
          const result = await provider.run({
            instance,
            runGlobals,
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
              discoveredJobs: [],
              sourceErrors: [
                `${instance.label}: ${result.error ?? "unknown error"}`,
              ],
            };
          }
          return { discoveredJobs: result.jobs, sourceErrors: [] };
        },
      });
    }
  }

  for (const [manifestId, grouped] of groupedByManifest) {
    const manifest = registry.manifests.get(manifestId);
    if (!manifest) continue;

    sourceTasks.push({
      source: manifest.id,
      platforms: [...grouped.sources],
      termsTotal: grouped.termsTotal,
      detail:
        grouped.sources.length > 1
          ? `${manifest.displayName}: ${grouped.sources.join(", ")}...`
          : grouped.detail,
      run: async () => {
        const row = sourceConfigByExtractor.get(manifest.id);
        const perSourceSettings = resolveSourceContextSettings({
          schema: manifest.configSchema,
          row: row ?? { config: {}, mappings: {} },
          runGlobals,
        });

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
            discoveredJobs: [],
            sourceErrors: [
              `${manifest.displayName || manifest.id}: ${result.error ?? "unknown error"} (sources: ${grouped.sources.join(",")})`,
            ],
          };
        }

        return {
          discoveredJobs: result.jobs,
          sourceErrors: [],
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
    return { discoveredJobs, sourceErrors };
  }

  const discoveryConcurrency = (await getEffectiveSettings())
    .discoveryConcurrency.value;

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
        for (const platform of sourceTask.platforms) {
          progressHelpers.markSourceFailed(platform, message);
        }
        return;
      }

      for (const platform of sourceTask.platforms) {
        const platformJobs = taskResult.discoveredJobs.filter(
          (job) => job.source === platform,
        );
        progressHelpers.recordSourceJobsCounts(platform, {
          scraped: platformJobs.length,
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
        };
      }
    },
  });

  for (const sourceResult of sourceResults) {
    discoveredJobs.push(...sourceResult.discoveredJobs);
    sourceErrors.push(...sourceResult.sourceErrors);
  }

  const locationFilterReasonCounts: Record<string, number> = {};
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
      : "location mismatch";
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
    return { discoveredJobs: filteredDiscoveredJobs, sourceErrors };
  }

  if (filteredDiscoveredJobs.length === 0 && sourceErrors.length > 0) {
    throw new Error(`All sources failed: ${sourceErrors.join("; ")}`);
  }

  if (sourceErrors.length > 0) {
    logger.warn("Some discovery sources failed", { sourceErrors });
  }

  progressHelpers.crawlingComplete(filteredDiscoveredJobs.length);

  return { discoveredJobs: filteredDiscoveredJobs, sourceErrors };
}
