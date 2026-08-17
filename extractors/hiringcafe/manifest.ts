import { resolveSearchCities } from "@shared/search-cities.js";
import type {
  ExtractorManifest,
  ExtractorProgressEvent,
  SourceConfigSchema,
} from "@shared/types";
import { runHiringCafe } from "./src/run";

const hiringcafeConfigSchema: SourceConfigSchema = {
  fields: [
    {
      key: "max_jobs_per_term",
      label: "Max jobs per term",
      type: "number",
      default: "200",
    },
    {
      key: "searchCities",
      label: "Search cities",
      type: "text",
      default: "",
      description:
        "Authoritative city fallback. Used when the Run modal's city mapping is disabled.",
    },
    {
      key: "workplaceTypes",
      label: "Workplace types",
      type: "text",
      default: "",
      description:
        'JSON-encoded array of "remote" | "hybrid" | "onsite". Used when the Run modal\'s workplace-types mapping is disabled.',
    },
    {
      key: "max_age_days",
      label: "Max job age (days)",
      type: "number",
      default: "",
      description:
        "Only request postings fetched in the last N days (maps to Hiring Cafe's dateFetchedPastNDays). That is the date Hiring Cafe indexed a posting, not the date it was published, so postings whose estimated publish date is older than this window are dropped during the scrape — its freshness is approximate either way. Leave blank to use the default 30-day window.",
    },
  ],
  globalMappings: [
    {
      globalField: "city",
      sourceField: "searchCities",
      enabledByDefault: true,
    },
    {
      globalField: "workplaceTypes",
      sourceField: "workplaceTypes",
      enabledByDefault: true,
    },
    {
      globalField: "maxJobsPerTerm",
      sourceField: "max_jobs_per_term",
      enabledByDefault: true,
    },
    {
      globalField: "maxAgeDays",
      sourceField: "max_age_days",
      enabledByDefault: true,
    },
  ],
};

function parseMaxAgeDays(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function toProgress(event: {
  type: string;
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  pageNo?: number;
  totalCollected?: number;
  descriptionsFetched?: number;
  descriptionsMissing?: number;
}): ExtractorProgressEvent {
  if (event.type === "term_start") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      currentUrl: event.searchTerm,
      detail: `Hiring Cafe: term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
    };
  }

  if (event.type === "page_fetched") {
    const pageNo = (event.pageNo ?? 0) + 1;
    const totalCollected = event.totalCollected ?? 0;
    // Descriptions are fetched per job from the detail page; surfacing the
    // count is the only in-run signal that the fetch still works at all.
    const fetched = event.descriptionsFetched ?? 0;
    const missing = event.descriptionsMissing ?? 0;
    const descriptions =
      fetched + missing > 0
        ? `, ${fetched}/${fetched + missing} with descriptions`
        : "";
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      listPagesProcessed: pageNo,
      jobPagesEnqueued: totalCollected,
      jobPagesProcessed: totalCollected,
      currentUrl: `page ${pageNo}`,
      detail: `Hiring Cafe: term ${event.termIndex}/${event.termTotal}, page ${pageNo} (${totalCollected} collected${descriptions})`,
    };
  }

  return {
    phase: "list",
    termsProcessed: event.termIndex,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    detail: `Hiring Cafe: completed term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
  };
}

export const manifest: ExtractorManifest = {
  id: "hiringcafe",
  displayName: "Hiring Cafe",
  description:
    "Aggregator with strong startup and remote coverage. Good signal, and fewer duplicates than the big boards.",
  providesSources: ["hiringcafe"],
  capabilities: { locationEvidence: true },
  configSchema: hiringcafeConfigSchema,
  async run(context) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const maxJobsPerTerm = context.settings.max_jobs_per_term
      ? parseInt(context.settings.max_jobs_per_term, 10)
      : 200;

    const result = await runHiringCafe({
      country: context.selectedCountry,
      countryKey: context.selectedCountry,
      searchTerms: context.searchTerms,
      locations: resolveSearchCities({
        single: context.settings.searchCities,
      }),
      workplaceTypes: context.settings.workplaceTypes
        ? JSON.parse(context.settings.workplaceTypes)
        : undefined,
      maxJobsPerTerm,
      maxAgeDays: parseMaxAgeDays(context.settings.max_age_days),
      onProgress: (event) => {
        if (context.shouldCancel?.()) return;

        context.onProgress?.(toProgress(event));
      },
    });

    if (!result.success) {
      return {
        success: false,
        jobs: [],
        error: result.error,
      };
    }

    return {
      success: true,
      jobs: result.jobs,
    };
  },
};

export default manifest;
