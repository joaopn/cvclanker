import type { CreateJobInput } from "./jobs";
import type { LocationIntent, SourceLocationPlan } from "./location";
import type { SourceConfigSchema } from "./source-config";

export interface ExtractorProgressEvent {
  phase?: "list" | "job";
  currentUrl?: string;
  termsProcessed?: number;
  termsTotal?: number;
  listPagesProcessed?: number;
  listPagesTotal?: number;
  jobCardsFound?: number;
  jobPagesEnqueued?: number;
  jobPagesSkipped?: number;
  jobPagesProcessed?: number;
  detail?: string;
}

export interface ExtractorCapabilities {
  locationEvidence?: boolean;
  /**
   * When true, the extractor's run() composes all searchTerms[] into a
   * single boolean-OR query per location and fires one request per
   * (joined-query, location) pair. When false (default) the runner loops
   * per term. Switching to true changes max_jobs_per_term from
   * "per term × location" to "per query × location" — the cap now
   * applies to the joined result set.
   */
  joinedTerms?: boolean;
}

export interface ExtractorRuntimeContext {
  source: string;
  selectedSources: string[];
  settings: Record<string, string | undefined>;
  searchTerms: string[];
  selectedCountry: string;
  locationIntent?: LocationIntent;
  sourceLocationPlan?: SourceLocationPlan;
  getExistingJobUrls?: () => Promise<string[]>;
  shouldCancel?: () => boolean;
  onProgress?: (event: ExtractorProgressEvent) => void;
}

export interface ExtractorRunResult {
  success: boolean;
  jobs: CreateJobInput[];
  error?: string;
  /**
   * Items the source returned that the mapper could not turn into a job —
   * missing url/title, an unrecognised site, a payload shape it does not know.
   *
   * Reported so the funnel can say so. Without it a source that returns 100
   * items and maps 80 is indistinguishable from one that found 80, and the
   * 20 vanish with no counter anywhere (B35). Optional so an extractor that
   * cannot drop anything need not carry it; absent reads as zero, never as
   * "unknown".
   */
  droppedCount?: number;
}

/** A mapping pass: what it produced, and how much it could not map. */
export interface MappedJobs {
  jobs: CreateJobInput[];
  dropped: number;
}

export interface ExtractorManifest {
  id: string;
  displayName: string;
  /** One line, shown next to the source's checkbox when picking sources. */
  description?: string;
  providesSources: readonly string[];
  requiredEnvVars?: readonly string[];
  capabilities?: ExtractorCapabilities;
  configSchema?: SourceConfigSchema;
  run: (context: ExtractorRuntimeContext) => Promise<ExtractorRunResult>;
}
