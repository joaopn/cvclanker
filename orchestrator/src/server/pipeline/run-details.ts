import {
  createLocationIntentFromLegacyInputs,
  planLocationSources,
} from "@shared/location-domain.js";
import { formatCountryLabel } from "@shared/location-support.js";
import type {
  AppSettings,
  PipelineConfig,
  PipelineRunEffectiveConfig,
  PipelineRunExecutionStage,
  PipelineRunRequestedConfig,
  PipelineRunResultSummary,
  PipelineRunSavedDetails,
} from "@shared/types";
import { getEffectiveSettings } from "../services/settings";

type SnapshotLocationIntent = NonNullable<PipelineConfig["locationIntent"]>;

function resolveLocationIntentSnapshot(
  config: PipelineConfig,
): SnapshotLocationIntent {
  return config.locationIntent ?? createLocationIntentFromLegacyInputs({});
}

export function buildRequestedConfigSnapshot(
  config: PipelineConfig,
): PipelineRunRequestedConfig {
  return {
    topN: config.topN,
    minSuitabilityCategory: config.minSuitabilityCategory,
    sources: [...(config.sources ?? [])],
    enableCrawling: config.enableCrawling !== false,
    enableScoring: config.enableScoring !== false,
    enableImporting: config.enableImporting !== false,
    enableAutoTailoring: config.enableAutoTailoring === true,
  };
}

function buildEffectiveConfigSnapshot(args: {
  requestedConfig: PipelineRunRequestedConfig;
  config: PipelineConfig;
  settings: AppSettings;
  locationIntent: SnapshotLocationIntent;
}): PipelineRunEffectiveConfig {
  const sourcePlans = planLocationSources({
    intent: args.locationIntent,
    sources: args.requestedConfig.sources,
  });
  const compatibleSources = args.requestedConfig.sources.filter((source) =>
    sourcePlans.compatibleSources.includes(source),
  );
  const country = args.locationIntent.selectedCountry;
  const countryLabel = country ? formatCountryLabel(country) || country : null;

  return {
    country,
    countryLabel,
    searchCities: [...args.locationIntent.cityLocations],
    searchTermsCount: args.config.searchTerms?.length ?? 0,
    workplaceTypes: [...args.locationIntent.workplaceTypes],
    locationSearchScope: args.locationIntent.searchScope,
    locationMatchStrictness: args.locationIntent.matchStrictness,
    compatibleSources,
    skippedSources: args.requestedConfig.sources
      .filter((source) => !compatibleSources.includes(source))
      .map((source) => ({
        source,
        reason:
          sourcePlans.plans
            .find((plan) => plan.source === source)
            ?.reasons.join(" ") || "Not available for the selected location",
      })),
    blockedCompanyKeywordsCount:
      args.config.blockedCompanyKeywords?.length ?? 0,
    sourceLimits: {
      maxJobsPerTerm: args.config.maxJobsPerTerm ?? null,
    },
    autoSkipCategory: args.settings.autoSkipCategory.value,
    models: {
      scorer: args.settings.modelScorer.value,
      tailoring: args.settings.modelTailoring.value,
      // Empty when off. A saved run that used a screen must say so, or it
      // misreports what actually classified its jobs.
      scorerPrefilter: args.settings.scorerPrefilterModel.value ?? "",
    },
  };
}

export async function buildPipelineRunSavedDetails(
  config: PipelineConfig,
): Promise<PipelineRunSavedDetails> {
  const requestedConfig = buildRequestedConfigSnapshot(config);
  const settings = await getEffectiveSettings();
  const locationIntent = resolveLocationIntentSnapshot(config);

  return {
    requestedConfig,
    effectiveConfig: buildEffectiveConfigSnapshot({
      requestedConfig,
      config,
      settings,
      locationIntent,
    }),
    resultSummary: createPipelineRunResultSummary(),
  };
}

export function createPipelineRunResultSummary(
  overrides: Partial<PipelineRunResultSummary> = {},
): PipelineRunResultSummary {
  return {
    stage: "started",
    jobsScored: null,
    jobsSelected: null,
    sourceErrors: [],
    ...overrides,
  };
}

export function updatePipelineRunResultSummary(
  current: PipelineRunResultSummary | null | undefined,
  update: Partial<PipelineRunResultSummary> & {
    stage?: PipelineRunExecutionStage;
  },
): PipelineRunResultSummary {
  return {
    ...createPipelineRunResultSummary(),
    ...(current ?? {}),
    ...update,
  };
}
