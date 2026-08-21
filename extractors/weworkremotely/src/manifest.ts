import type {
  ExtractorManifest,
  ExtractorProgressEvent,
  SourceConfigSchema,
} from "@shared/types";
import {
  DEFAULT_CATEGORIES,
  runWeWorkRemotely,
  type WeWorkRemotelyProgressEvent,
} from "./run";

const wwrConfigSchema: SourceConfigSchema = {
  fields: [
    {
      key: "max_jobs_per_term",
      label: "Max jobs",
      type: "number",
      default: "50",
      description:
        "We Work Remotely has no keyword search, so all search terms are matched client-side against the configured category feeds — this cap applies to the joined result set, not per term.",
    },
    {
      key: "categories",
      label: "Category feeds",
      type: "text",
      default: DEFAULT_CATEGORIES.join("|"),
      description:
        '"|"-separated We Work Remotely category slugs (the path segment in weworkremotely.com/categories/<slug>). Defaults to the four programming feeds.',
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
        "Feed items older than this many days are skipped. Leave blank to take each feed whole — a feed only ever holds its ~200 newest postings.",
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

function toProgress(
  event: WeWorkRemotelyProgressEvent,
): ExtractorProgressEvent {
  if (event.type === "term_start") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      currentUrl: event.searchTerm,
      detail: `We Work Remotely: feed ${event.termIndex}/${event.termTotal} (${event.searchTerm})`,
    };
  }

  return {
    phase: "list",
    termsProcessed: event.termIndex,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    jobPagesEnqueued: event.jobsFoundTerm,
    jobPagesProcessed: event.jobsFoundTerm,
    detail: `We Work Remotely: feed ${event.termIndex}/${event.termTotal} done with ${event.jobsFoundTerm} jobs (${event.searchTerm})`,
  };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCategories(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const slugs = raw
    .split(/[|\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
  return slugs.length > 0 ? slugs : undefined;
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
  id: "weworkremotely",
  displayName: "We Work Remotely",
  description:
    "Remote-only board; regions mark who may apply. Runs only on remote-type Search Profiles.",
  providesSources: ["weworkremotely"],
  capabilities: { locationEvidence: true, joinedTerms: true },
  configSchema: wwrConfigSchema,
  async run(context) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const result = await runWeWorkRemotely({
      searchTerms: context.searchTerms,
      workplaceTypes: parseWorkplaceTypes(context.settings.workplaceTypes),
      categories: parseCategories(context.settings.categories),
      maxJobs: parsePositiveInt(context.settings.max_jobs_per_term),
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
