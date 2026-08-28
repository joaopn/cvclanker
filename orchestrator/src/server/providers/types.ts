import type {
  CreateJobInput,
  ProviderInstanceRow,
  SourceConfigGlobalField,
  SourceConfigRunGlobals,
} from "@shared/types";
import type { ExtractorProgressEvent, ExtractorRunResult } from "@shared/types";

export interface ProviderRunContext {
  instance: ProviderInstanceRow;
  runGlobals: SourceConfigRunGlobals;
  apiToken: string | null;
  searchTerms: string[];
  shouldCancel?: () => boolean;
  onProgress?: (event: ExtractorProgressEvent) => void;
}

export interface ProviderActorTemplate {
  id: string;
  providerId: string;
  actorRef: string;
  displayName: string;
  description: string;
  defaultInputTemplate: string;
  defaultMappings: Partial<Record<SourceConfigGlobalField, boolean>>;
  /**
   * What this actor does with a max job age, in one sentence, shown beside the
   * per-instance field. Omitted for actors with no opinion (freeform).
   */
  maxAgeNote?: string;
  /**
   * The discrete recency windows this actor accepts, in ascending days, when it
   * cannot take an arbitrary day count. A request between two entries rounds UP
   * to the next; a request wider than the LAST entry is clamped to it, which
   * scrapes less than was asked for. `bucketWindowDays` owns the rule and the
   * run-window gate reads this to refuse a request the actor would truncate.
   */
  maxAgeBuckets?: readonly number[];
  /**
   * Lower bounds for numeric placeholders this actor enforces server-side
   * (e.g. curious_coder/linkedin-jobs-scraper rejects count < 10). Clamped
   * during input substitution so a small maxJobsPerTerm never 400s the run.
   */
  placeholderMinimums?: Partial<Record<string, number>>;
  /**
   * Optional computed-input hook. When present, the provider calls it after
   * substituting the stored input template and uses its return value as the
   * actor input. URL-driven actors (e.g. LinkedIn) use this to build their
   * search URLs from the live run context — search terms + configured
   * location — instead of a hand-pasted, location-pinned URL. `base` is the
   * already-substituted stored input, so the hook can preserve per-instance
   * knobs (scrapeCompany, count, …) and override only the fields it computes.
   */
  buildInput?(context: ProviderRunContext, base: unknown): unknown;
  mapItem(
    item: unknown,
    context: { sourceId: string },
  ): CreateJobInput | null;
}

export interface ProviderRunner {
  id: string;
  displayName: string;
  templates: readonly ProviderActorTemplate[];
  run(context: ProviderRunContext): Promise<ExtractorRunResult>;
}

export type ProviderRegistry = Map<string, ProviderRunner>;
