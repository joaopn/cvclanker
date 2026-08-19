import { resolveSearchCities } from "@shared/search-cities.js";
import type {
  ExtractorManifest,
  ExtractorProgressEvent,
  SourceConfigSchema,
} from "@shared/types";
import { runStartupJobs } from "./run";

const startupjobsConfigSchema: SourceConfigSchema = {
  fields: [
    {
      key: "max_jobs_per_term",
      label: "Max jobs per term",
      type: "number",
      default: "50",
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
  ],
};

function toProgress(event: {
  type: string;
  termIndex: number;
  termTotal: number;
  searchTerm: string;
  location?: string;
  jobsFoundTerm?: number;
}): ExtractorProgressEvent {
  const scope = event.location
    ? `${event.searchTerm} @ ${event.location}`
    : event.searchTerm;

  if (event.type === "term_start") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      currentUrl: scope,
      detail: `startup.jobs: term ${event.termIndex}/${event.termTotal} (${scope})`,
    };
  }

  return {
    phase: "list",
    termsProcessed: event.termIndex,
    termsTotal: event.termTotal,
    currentUrl: scope,
    jobPagesProcessed: event.jobsFoundTerm ?? 0,
    jobPagesEnqueued: event.jobsFoundTerm ?? 0,
    detail: `startup.jobs: completed ${event.termIndex}/${event.termTotal} (${scope}) with ${event.jobsFoundTerm ?? 0} jobs`,
  };
}

export const manifest: ExtractorManifest = {
  id: "startupjobs",
  displayName: "startup.jobs",
  description:
    "Startup-focused board. Lower volume, but a high share of early-stage roles.",
  providesSources: ["startupjobs"],
  configSchema: startupjobsConfigSchema,
  async run(context) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const parsedMaxJobsPerTerm = context.settings.max_jobs_per_term
      ? Number.parseInt(context.settings.max_jobs_per_term, 10)
      : Number.NaN;
    const maxJobsPerTerm = Number.isFinite(parsedMaxJobsPerTerm)
      ? Math.max(1, parsedMaxJobsPerTerm)
      : 50;

    const result = await runStartupJobs({
      selectedCountry: context.selectedCountry,
      searchTerms: context.searchTerms,
      locations: resolveSearchCities({
        single: context.settings.searchCities,
      }),
      workplaceTypes: context.settings.workplaceTypes
        ? JSON.parse(context.settings.workplaceTypes)
        : undefined,
      maxJobsPerTerm,
      shouldCancel: context.shouldCancel,
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
      // Forwarded, not dropped: this wrapper is the only path from the runner
      // to the pipeline, so re-wrapping without it makes the funnel's
      // unreadable-item count permanently zero (B35).
      droppedCount: result.droppedCount,
    };
  },
};

export default manifest;
