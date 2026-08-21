import type {
  ExtractorManifest,
  ExtractorProgressEvent,
  SourceConfigSchema,
} from "@shared/types";
import { type HimalayasProgressEvent, runHimalayas } from "./run";

const himalayasConfigSchema: SourceConfigSchema = {
  fields: [
    {
      key: "max_jobs_per_term",
      label: "Max jobs",
      type: "number",
      default: "50",
      description:
        "Himalayas has no keyword search, so all search terms are matched client-side against one newest-first walk of the board — this cap applies to the joined result set, not per term.",
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
        "The board is walked newest-first and the walk stops at the first posting older than this window (default 7 days when blank — the API has no keyword filter, so the window is what bounds a run). Hard backstop: at most 1,000 rows are read per run.",
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

function toProgress(event: HimalayasProgressEvent): ExtractorProgressEvent {
  if (event.type === "term_start") {
    return {
      phase: "list",
      termsProcessed: Math.max(event.termIndex - 1, 0),
      termsTotal: event.termTotal,
      currentUrl: event.searchTerm,
      detail: `Himalayas: searching (${event.searchTerm})`,
    };
  }

  return {
    phase: "list",
    termsProcessed: event.termIndex,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    jobPagesEnqueued: event.jobsFoundTerm,
    jobPagesProcessed: event.jobsFoundTerm,
    detail: `Himalayas: found ${event.jobsFoundTerm} jobs (${event.searchTerm})`,
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
  id: "himalayas",
  displayName: "Himalayas",
  description:
    "Remote-only aggregator with structured country-eligibility data. Runs only on remote-type Search Profiles.",
  providesSources: ["himalayas"],
  capabilities: { locationEvidence: true, joinedTerms: true },
  configSchema: himalayasConfigSchema,
  async run(context) {
    if (context.shouldCancel?.()) {
      return { success: true, jobs: [] };
    }

    const result = await runHimalayas({
      searchTerms: context.searchTerms,
      workplaceTypes: parseWorkplaceTypes(context.settings.workplaceTypes),
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
