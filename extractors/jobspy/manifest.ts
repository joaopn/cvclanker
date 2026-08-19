import type {
  ExtractorManifest,
  ExtractorRuntimeContext,
  SourceConfigSchema,
} from "@shared/types";
import { runJobSpy } from "./src/run";

const jobspyConfigSchema: SourceConfigSchema = {
  fields: [
    {
      key: "max_jobs_per_term",
      label: "Max jobs per term",
      type: "number",
      default: "20",
      description:
        "JobSpy joins all search terms into one boolean-OR query, so this cap applies to the joined result set per location, not per individual term.",
    },
    {
      key: "country_indeed",
      label: "Country (Indeed)",
      type: "text",
      default: "",
      description: "Region for Indeed sub-source.",
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
        "Only request postings newer than this many days (maps to JobSpy's hours_old = days × 24). Leave blank to use JobSpy's default window.",
    },
  ],
  globalMappings: [
    {
      globalField: "city",
      sourceField: "searchCities",
      enabledByDefault: true,
    },
    {
      globalField: "country",
      sourceField: "country_indeed",
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

type JobSpySite = NonNullable<Parameters<typeof runJobSpy>[0]["sites"]>[number];

const JOBSPY_SOURCES = new Set<JobSpySite>(["indeed", "linkedin", "glassdoor"]);

function isJobSpySite(source: string): source is JobSpySite {
  return JOBSPY_SOURCES.has(source as JobSpySite);
}

export const manifest: ExtractorManifest = {
  id: "jobspy",
  displayName: "JobSpy",
  description:
    "LinkedIn, Indeed and Glassdoor in one scraper. The broadest source, and the best coverage of large employers.",
  providesSources: ["indeed", "linkedin", "glassdoor"],
  capabilities: { locationEvidence: true, joinedTerms: true },
  configSchema: jobspyConfigSchema,
  async run(context: ExtractorRuntimeContext) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const sites = context.selectedSources.filter(isJobSpySite);

    const maxAgeDays = parseMaxAgeDays(context.settings.max_age_days);

    const result = await runJobSpy({
      sites,
      searchTerms: context.searchTerms,
      location: context.settings.searchCities,
      resultsWanted: context.settings.max_jobs_per_term
        ? parseInt(context.settings.max_jobs_per_term, 10)
        : undefined,
      hoursOld: maxAgeDays !== undefined ? maxAgeDays * 24 : undefined,
      countryIndeed: context.settings.country_indeed,
      workplaceTypes: context.settings.workplaceTypes
        ? JSON.parse(context.settings.workplaceTypes)
        : undefined,
      onProgress: (event) => {
        if (context.shouldCancel?.()) return;

        if (event.type === "term_start") {
          context.onProgress?.({
            phase: "list",
            termsProcessed: Math.max(event.termIndex - 1, 0),
            termsTotal: event.termTotal,
            currentUrl: event.searchTerm,
            detail: `JobSpy: term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
          });
          return;
        }

        context.onProgress?.({
          phase: "list",
          termsProcessed: event.termIndex,
          termsTotal: event.termTotal,
          currentUrl: event.searchTerm,
          detail: `JobSpy: completed ${event.termIndex}/${event.termTotal} (${event.searchTerm}) with ${event.jobsFoundTerm} jobs`,
        });
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
      // Forwarded, not dropped: this wrapper is the only path from the runner
      // to the pipeline, so re-wrapping without it makes the funnel's
      // unreadable-item count permanently zero (B35).
      droppedCount: result.droppedCount,
    };
  },
};

export default manifest;
