import type {
  ExtractorManifest,
  ExtractorProgressEvent,
  SourceConfigSchema,
} from "@shared/types";
import { type JobicyProgressEvent, runJobicy } from "./run";

const jobicyConfigSchema: SourceConfigSchema = {
  fields: [
    {
      key: "max_jobs_per_term",
      label: "Max jobs per term",
      type: "number",
      default: "50",
      description:
        "One Jobicy request per search term (server-side tag filter), capped at this many results each; the same posting matching several terms is deduplicated by URL. The API serves at most 100 per request.",
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
      key: "geo",
      label: "Geo filter",
      type: "text",
      default: "",
      description:
        "Optional Jobicy geo slug sent server-side (e.g. portugal, uk, usa, emea) to narrow what the board returns. Blank = no geo filter — remote profiles filter by their location blocklist instead. Jobicy resolves region membership itself, so a country slug also returns EMEA/Europe/Anywhere postings.",
    },
    {
      key: "max_age_days",
      label: "Max job age (days)",
      type: "number",
      default: "",
      description:
        "Postings older than this many days are skipped. Leave blank to take each response whole — the API returns its newest postings per filter anyway.",
    },
  ],
  globalMappings: [
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

function toProgress(event: JobicyProgressEvent): ExtractorProgressEvent {
  if (event.type === "term_start") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      currentUrl: event.searchTerm,
      detail: `Jobicy: term ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
    };
  }

  return {
    phase: "list",
    termsProcessed: event.termIndex,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    jobPagesEnqueued: event.jobsFoundTerm,
    jobPagesProcessed: event.jobsFoundTerm,
    detail: `Jobicy: completed ${event.termIndex}/${event.termTotal} (${event.searchTerm}) with ${event.jobsFoundTerm} jobs`,
  };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseWorkplaceTypes(
  raw: string | undefined,
): Array<"remote" | "hybrid" | "onsite"> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const out = parsed.filter(
      (value): value is "remote" | "hybrid" | "onsite" =>
        value === "remote" || value === "hybrid" || value === "onsite",
    );
    return out.length > 0 ? out : undefined;
  } catch {
    // A malformed stored value must not fail the whole source.
    return undefined;
  }
}

export const manifest: ExtractorManifest = {
  id: "jobicy",
  displayName: "Jobicy",
  description:
    "Remote-only board with a server-side geo-eligibility filter. Runs only on remote-type Search Profiles.",
  providesSources: ["jobicy"],
  capabilities: { locationEvidence: true },
  configSchema: jobicyConfigSchema,
  async run(context) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const result = await runJobicy({
      searchTerms: context.searchTerms,
      workplaceTypes: parseWorkplaceTypes(context.settings.workplaceTypes),
      // Opt-in narrowing only: a remote profile is a blacklist, so the
      // profile's country is deliberately NOT sent as a geo filter.
      selectedCountry: context.settings.geo || undefined,
      maxJobsPerTerm: parsePositiveInt(context.settings.max_jobs_per_term),
      maxAgeDays: parsePositiveInt(context.settings.max_age_days),
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (context.shouldCancel?.()) return;
        context.onProgress?.(toProgress(event));
      },
    });

    if (!result.success) {
      return { success: false, jobs: [], error: result.error };
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
