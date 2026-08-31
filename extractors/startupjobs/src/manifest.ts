import { resolveSearchCities } from "@shared/search-cities.js";
import type {
  ExtractorManifest,
  ExtractorProgressEvent,
  SourceConfigSchema,
} from "@shared/types";
import { runStartupJobs } from "./run";

/**
 * Detail-page fetch width. One, not the package's 8, because that is the rate
 * measured getting this machine refused: a leg fetches on the order of 570
 * detail pages, so 8 sustains roughly 6 requests/second against a
 * Cloudflare-fronted site while 1 lands near the ~1/s that both the safe probe
 * and the repo's existing per-IP pacer use. The cost is real — a leg's detail
 * phase stretches from ~1-2 minutes to ~10 — which is why it is a config field
 * rather than a constant: the site's actual threshold is not derivable, so the
 * value belongs where it can be tuned against observed runs.
 *
 * Duplicated as a code fallback rather than left to the schema `default`
 * because `extractor-health.ts` calls `manifest.run` directly with its own
 * settings object, bypassing `resolveSourceContextSettings` — which is the only
 * thing that applies schema defaults. Without this the health probe would still
 * run at 8.
 */
const DEFAULT_DETAIL_CONCURRENCY = 1;

const startupjobsConfigSchema: SourceConfigSchema = {
  fields: [
    {
      key: "max_jobs_per_term",
      label: "Max jobs per term",
      type: "number",
      default: "50",
    },
    {
      key: "detail_concurrency",
      label: "Detail concurrency",
      type: "number",
      default: String(DEFAULT_DETAIL_CONCURRENCY),
      description:
        "How many job pages to fetch at once. startup.jobs is behind Cloudflare and limits per IP; the scraper's own default of 8 is high enough to get this machine rate-limited part-way through a run. Raise it only if runs are completing cleanly.",
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

    const parsedDetailConcurrency = context.settings.detail_concurrency
      ? Number.parseInt(context.settings.detail_concurrency, 10)
      : Number.NaN;
    const detailConcurrency = Number.isFinite(parsedDetailConcurrency)
      ? Math.max(1, parsedDetailConcurrency)
      : DEFAULT_DETAIL_CONCURRENCY;

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
      detailConcurrency,
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (context.shouldCancel?.()) return;
        context.onProgress?.(toProgress(event));
      },
    });

    if (!result.success) {
      return {
        success: false,
        // Salvaged rows ride the failure, same as the Apify provider: the
        // runner keeps what it scraped before a refusal, and returning [] here
        // would throw it away a second time after run.ts kept it.
        jobs: result.jobs,
        droppedCount: result.droppedCount,
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
