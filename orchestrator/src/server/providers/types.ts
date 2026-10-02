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
  /**
   * Each term's result budget, keyed by `termKey`, for a template with
   * `perTermRuns`. A term missing here falls back to the run's
   * `maxJobsPerTerm`.
   */
  termBudgets?: Readonly<Record<string, number>>;
  /**
   * Set only on the context a `perTermRuns` template's `buildInput` receives:
   * the budget of the one term in `searchTerms`.
   */
  termBudget?: number;
  /**
   * For a template with `termEarlyStop`: stop a term's run once fewer than
   * this many of each search's last `TERM_STOP_WINDOW` results name the term.
   * 0 or absent never stops early.
   */
  termStopMinMatches?: number;
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
  /**
   * Run the actor once per search term, one after another, instead of once
   * for all of them. `buildInput` then receives a context holding that single
   * term in `searchTerms` and its budget in `termBudget`, and must cap the
   * run's total results at that budget: a term is reported `capped` when its
   * run returns that many items.
   */
  perTermRuns?: true;
  /**
   * For a `perTermRuns` template: the smallest run the actor accepts, which
   * lifts every term's budget to it. The lifted number is the term's budget
   * from then on, in the run's cap and in its reported outcome, so a term the
   * actor ran short of is `under` rather than `capped` against a smaller
   * number nobody asked the actor for.
   */
  minTermBudget?: number;
  /**
   * For a `perTermRuns` template whose items say where they ranked: lets a
   * term's run stop once its results stop naming the term (see
   * `@shared/term-stop`). Without it a term's run always goes to its budget.
   */
  termEarlyStop?: {
    /** Which search an item came from, and its rank there (1 first). */
    rankOf(item: unknown): { search: string; rank: number } | null;
    /**
     * The searches the built input runs, keyed as `rankOf` names them, and
     * each one's own result cap.
     */
    searchesOf(input: unknown): {
      searches: string[];
      cap: number | undefined;
    };
  };
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
