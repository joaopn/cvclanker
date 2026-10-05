import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { asyncPool } from "@server/utils/async-pool";
import { MIN_TERM_JOB_BUDGET, termKey } from "@shared/term-budgets.js";
import {
  TERM_STOP_WINDOW,
  type TermStopResult,
  TermStopTracker,
} from "@shared/term-stop.js";
import type {
  CreateJobInput,
  ExtractorRunResult,
  JobSource,
  TermBudgetOutcome,
} from "@shared/types";
import type {
  ProviderActorTemplate,
  ProviderRunContext,
  ProviderRunner,
} from "../types";
import {
  ApifyApiError,
  type ApifyRunOutcome,
  type RunActorArgs,
  runApifyActor,
} from "./client";
import {
  applyFreeformMapping,
  FreeformMappingError,
  parseMappingSpec,
} from "./freeform-mapper";
import {
  substituteInputTemplate,
  TemplateSubstitutionError,
} from "./template-substitute";
import { APIFY_TEMPLATES, findApifyTemplate } from "./templates";
import { FALLBACK_MAX_JOBS_PER_TERM } from "./templates/mapper-helpers";

function providerSourceId(instanceId: string): JobSource {
  return `apify:${instanceId}` as JobSource;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : fallback;
}

type Built<T> = { ok: true; value: T } | { ok: false; error: string };

// The stored template substituted from the live run context.
function substituteStoredInput(
  context: ProviderRunContext,
  template: ProviderActorTemplate | undefined,
): Built<unknown> {
  const { instance, runGlobals, searchTerms } = context;
  try {
    const value = substituteInputTemplate({
      templateJson: instance.inputTemplateJson,
      runGlobals,
      searchTerms,
      placeholderMinimums: template?.placeholderMinimums,
      maxJobs: instance.maxJobs,
      maxAgeDays: instance.maxAgeDays,
    });
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof TemplateSubstitutionError
          ? error.message
          : errorMessage(error, "Failed to substitute input template"),
    };
  }
}

// The stored template substituted from the live run context, then handed to
// the template's `buildInput` hook when it has one.
function buildActorInput(
  context: ProviderRunContext,
  template: ProviderActorTemplate | undefined,
): Built<unknown> {
  const substituted = substituteStoredInput(context, template);
  if (!substituted.ok) return substituted;
  let resolvedInput = substituted.value;

  // URL-driven actors (LinkedIn) compute their search URLs from the live run
  // context (search terms + location) so the configured location is honored
  // and stale, location-pinned URLs stored on the instance are overridden.
  if (template?.buildInput) {
    try {
      resolvedInput = template.buildInput(context, resolvedInput);
    } catch (error) {
      return {
        ok: false,
        error: errorMessage(error, "Failed to build actor input"),
      };
    }
  }
  return { ok: true, value: resolvedInput };
}

type MappedItems = { mapped: CreateJobInput[]; droppedCount: number };

function mapDatasetItems(
  context: ProviderRunContext,
  template: ProviderActorTemplate | undefined,
  datasetItems: unknown[],
): Built<MappedItems> {
  const { instance, shouldCancel } = context;
  const sourceId = providerSourceId(instance.id);
  const mapped: CreateJobInput[] = [];
  let droppedCount = 0;

  if (template) {
    for (const item of datasetItems) {
      if (shouldCancel?.()) break;
      try {
        const job = template.mapItem(item, { sourceId });
        if (job) mapped.push(job);
        else droppedCount += 1;
      } catch (error) {
        droppedCount += 1;
        logger.warn("Curated Apify mapper threw on item", {
          actorRef: instance.actorRef,
          templateId: instance.templateId,
          error: sanitizeUnknown(error),
        });
      }
    }
  } else {
    let spec: ReturnType<typeof parseMappingSpec>;
    try {
      spec = parseMappingSpec(instance.outputMappingJson);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof FreeformMappingError
            ? error.message
            : errorMessage(error, "Output mapping invalid"),
      };
    }
    for (const item of datasetItems) {
      if (shouldCancel?.()) break;
      const job = applyFreeformMapping({ spec, item, sourceId });
      if (job) mapped.push(job);
      else droppedCount += 1;
    }
  }

  if (droppedCount > 0) {
    logger.info("Apify mapper dropped items missing required fields", {
      actorRef: instance.actorRef,
      templateId: instance.templateId ?? null,
      droppedCount,
      mappedCount: mapped.length,
      totalCount: datasetItems.length,
    });
  }
  return { ok: true, value: { mapped, droppedCount } };
}

// A run that died — its own timeout, or an abort — after scraping these rows.
function describeUnfinishedRun(
  status: ApifyRunOutcome["status"],
  itemCount: number,
  mappedCount: number,
): string {
  const how = status === "TIMED-OUT" ? "timed out" : "was aborted";
  return `Actor run ${how} after scraping ${itemCount} item(s); kept the ${mappedCount} job(s) mapped from them`;
}

async function runOnce(
  context: ProviderRunContext,
  template: ProviderActorTemplate | undefined,
): Promise<ExtractorRunResult> {
  const input = buildActorInput(context, template);
  if (!input.ok) return { success: false, jobs: [], error: input.error };

  let runOutcome: ApifyRunOutcome;
  try {
    runOutcome = await runApifyActor({
      token: context.apiToken ?? "",
      actorRef: context.instance.actorRef,
      input: input.value,
      shouldCancel: context.shouldCancel,
    });
  } catch (error) {
    return {
      success: false,
      jobs: [],
      error:
        error instanceof ApifyApiError
          ? error.message
          : errorMessage(error, String(error)),
    };
  }

  const mapping = mapDatasetItems(context, template, runOutcome.items);
  if (!mapping.ok) return { success: false, jobs: [], error: mapping.error };
  const { mapped, droppedCount } = mapping.value;

  if (runOutcome.status !== "SUCCEEDED") {
    // success:false + jobs carries the salvaged rows out: discovery imports
    // what was paid for while the source still reads as failed, so its scrape
    // watermark stays put and a retry is offered (B42's salvage half).
    return {
      success: false,
      jobs: mapped,
      droppedCount,
      error: describeUnfinishedRun(
        runOutcome.status,
        runOutcome.items.length,
        mapped.length,
      ),
    };
  }
  return { success: true, jobs: mapped, droppedCount };
}

/** The run's terms, trimmed, blanks dropped, case-insensitive repeats dropped. */
function distinctTerms(searchTerms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of searchTerms) {
    const term = raw.trim();
    const key = termKey(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

// How often a run that may stop early is checked. Measured rows arrive at
// about 1.4 a second (200 in about 140s), so a stop overshoots by a poll's
// worth, about 15 paid rows, plus what lands while the run winds down, at the
// cost of one status and one dataset request per check.
const TERM_STOP_POLL_SECS = 10;

/**
 * The watch that stops a term's run once its results stop naming the term,
 * or undefined when the template cannot rank its items or the setting is off.
 */
function termStopWatch(
  context: ProviderRunContext,
  template: ProviderActorTemplate,
  term: string,
  input: unknown,
): RunActorArgs["watch"] {
  const early = template.termEarlyStop;
  const minMatches = context.termStopMinMatches ?? 0;
  if (!early || minMatches <= 0) return undefined;
  const sourceId = providerSourceId(context.instance.id);
  const { searches, cap } = early.searchesOf(input);
  const tracker = new TermStopTracker({
    term,
    searches,
    searchCap: cap,
    minMatches,
  });
  let seen = 0;
  let rankedAny = false;
  let warned = false;
  return {
    pollSecs: TERM_STOP_POLL_SECS,
    // `items` only ever grows, so each item is read once.
    shouldStop: (items) => {
      // `rankOf` gives an item's search and rank together, so an item it
      // cannot rank is left out; a search such items filled to its cap still
      // goes quiet and counts as finished once it holds a rankable result,
      // and one that holds none keeps the run going.
      const fresh: TermStopResult[] = [];
      for (const item of items.slice(seen)) {
        const ranked = early.rankOf(item);
        if (!ranked) continue;
        rankedAny = true;
        fresh.push({
          ...ranked,
          title: template.mapItem(item, { sourceId })?.title ?? null,
        });
      }
      seen = items.length;
      if (!rankedAny && !warned && seen >= TERM_STOP_WINDOW * 3) {
        // The run still goes to its budget; this says why it never stops.
        warned = true;
        logger.warn("Apify term run cannot rank its results; no early stop", {
          actorRef: context.instance.actorRef,
          term,
          items: seen,
        });
      }
      return tracker.observe(fresh, Date.now());
    },
  };
}

// A run with no profile carries no budgets, so each term gets the run's own
// per-term cap.
function termBudgetFor(
  context: ProviderRunContext,
  template: ProviderActorTemplate,
  term: string,
): number {
  const budgets = context.termBudgets;
  const key = termKey(term);
  let budget: number;
  if (budgets && Object.hasOwn(budgets, key)) {
    budget = budgets[key];
  } else {
    const perTerm = Number(context.runGlobals.maxJobsPerTerm);
    budget =
      Number.isFinite(perTerm) && perTerm > 0
        ? Math.floor(perTerm)
        : FALLBACK_MAX_JOBS_PER_TERM;
  }
  return Math.max(
    MIN_TERM_JOB_BUDGET,
    template.minTermBudget ?? 0,
    Math.floor(budget),
  );
}

type TermRunInput = { input: unknown; cap: number };

// One term's actor runs: `termRunInputs` when the template splits a term into
// several, else the single `buildInput` result, capped at the term's budget.
function buildTermInputs(
  termContext: ProviderRunContext,
  template: ProviderActorTemplate,
  budget: number,
): Built<TermRunInput[]> {
  if (!template.termRunInputs) {
    const input = buildActorInput(termContext, template);
    return input.ok
      ? { ok: true, value: [{ input: input.value, cap: budget }] }
      : input;
  }
  const substituted = substituteStoredInput(termContext, template);
  if (!substituted.ok) return substituted;
  try {
    const inputs = template.termRunInputs(termContext, substituted.value);
    if (inputs.length === 0) {
      return { ok: false, error: "No search to run for this term" };
    }
    return { ok: true, value: inputs };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error, "Failed to build actor input"),
    };
  }
}

/** What one actor run of a term came back with. */
type TermRunResult =
  | { kind: "error"; error: string }
  | {
      kind: "done";
      outcome: ApifyRunOutcome;
      mapped: CreateJobInput[];
      droppedCount: number;
    };

/** One term's place in a per-term run, before and after its runs. */
type TermPlan =
  | { term: string; budget: number; state: "not_run" }
  | { term: string; budget: number; state: "build_failed"; error: string }
  | {
      term: string;
      budget: number;
      state: "planned";
      context: ProviderRunContext;
      /** Indexes into the run list, one per actor run of this term. */
      runs: number[];
    };

/**
 * One actor run per search term (or several, for a template that searches one
 * location per run), each term capped at its budget. Terms run one after
 * another in the run's term order, or as a pool of `termRunConcurrency` for a
 * template with `parallelTermRuns`; either way the outcomes, rows and errors
 * come back in term order.
 *
 * - A run that throws (a FAILED run, an API error) starts nothing further:
 *   those are usually account-wide and would fail every later run the same
 *   way. Runs already going finish.
 * - A run that times out is about its own term: its rows are kept, the term
 *   is `failed`, and the other runs carry on.
 * - A cancel starts nothing further. Mapping stops at a cancel, as it does
 *   for a single run, so a run mapped after one keeps no rows, including a
 *   run that finished: a cancelled pipeline imports nothing anyway, and the
 *   source preview's deadline aborts the runs still going when it cancels.
 * - Every term's input is built before any run starts, so a term whose input
 *   cannot be built is reported `failed` even if an earlier run then throws.
 * - A term whose input cannot be built is `failed` and nothing after it in
 *   the term order is searched.
 *
 * Any failed or unsearched term makes the result a failure, which holds the
 * source's scrape watermark back so the next window re-covers the gap.
 */
async function runPerTerm(
  context: ProviderRunContext,
  template: ProviderActorTemplate,
): Promise<ExtractorRunResult> {
  const { shouldCancel, onProgress } = context;
  const terms = distinctTerms(context.searchTerms);

  const plans: TermPlan[] = [];
  const runs: Array<{
    planIndex: number;
    term: string;
    input: unknown;
    cap: number;
  }> = [];
  let buildFailed = false;
  for (const term of terms) {
    const budget = termBudgetFor(context, template, term);
    if (buildFailed) {
      plans.push({ term, budget, state: "not_run" });
      continue;
    }
    const termContext: ProviderRunContext = {
      ...context,
      searchTerms: [term],
      termBudget: budget,
    };
    const inputs = buildTermInputs(termContext, template, budget);
    if (!inputs.ok) {
      plans.push({ term, budget, state: "build_failed", error: inputs.error });
      buildFailed = true;
      continue;
    }
    const planIndex = plans.length;
    const runIndexes = inputs.value.map(({ input, cap }) => {
      runs.push({ planIndex, term, input, cap });
      return runs.length - 1;
    });
    plans.push({
      term,
      budget,
      state: "planned",
      context: termContext,
      runs: runIndexes,
    });
  }

  const results: Array<TermRunResult | undefined> = runs.map(() => undefined);
  const jobsSoFar = () =>
    results.reduce(
      (sum, result) =>
        sum + (result?.kind === "done" ? result.mapped.length : 0),
      0,
    );
  // A term counts as processed once every one of its runs has settled, so
  // the count only ever grows however the pool interleaves them.
  const termsProcessed = () =>
    plans.filter(
      (plan) =>
        plan.state !== "planned" ||
        plan.runs.every((runIndex) => results[runIndex] !== undefined),
    ).length;
  const report = () => {
    const processed = termsProcessed();
    const jobCount = jobsSoFar();
    onProgress?.({
      termsProcessed: processed,
      termsTotal: terms.length,
      // Sent as a pair: the live line reads "processed/enqueued", and there
      // is no separate count of pages queued for an actor run.
      jobPagesEnqueued: jobCount,
      jobPagesProcessed: jobCount,
      detail: `${context.instance.label}: ${processed}/${terms.length} search terms`,
    });
  };

  onProgress?.({
    termsProcessed: 0,
    termsTotal: terms.length,
    jobPagesEnqueued: 0,
    jobPagesProcessed: 0,
    detail: `${context.instance.label}: 0/${terms.length} search terms`,
  });

  let stopped = false;
  await asyncPool({
    items: runs,
    concurrency: template.parallelTermRuns
      ? (context.termRunConcurrency ?? 1)
      : 1,
    shouldStop: () => stopped || shouldCancel?.() === true,
    task: async (run, runIndex) => {
      const plan = plans[run.planIndex];
      if (plan.state !== "planned") return;
      let result: TermRunResult;
      try {
        const outcome = await runApifyActor({
          token: context.apiToken ?? "",
          actorRef: context.instance.actorRef,
          input: run.input,
          shouldCancel,
          watch: termStopWatch(context, template, run.term, run.input),
          timeoutSecs: template.runTimeoutSecs,
        });
        const mapping = mapDatasetItems(plan.context, template, outcome.items);
        result = mapping.ok
          ? {
              kind: "done",
              outcome,
              mapped: mapping.value.mapped,
              droppedCount: mapping.value.droppedCount,
            }
          : { kind: "error", error: mapping.error };
      } catch (error) {
        result = {
          kind: "error",
          error: errorMessage(error, String(error)),
        };
      }
      if (result.kind === "error") stopped = true;
      results[runIndex] = result;
      report();
    },
  });

  const outcomes: TermBudgetOutcome[] = [];
  const jobs: CreateJobInput[] = [];
  const errors: string[] = [];
  let droppedCount = 0;
  for (const plan of plans) {
    const { term, budget } = plan;
    if (plan.state === "not_run") {
      outcomes.push({ term, budget, scraped: 0, status: "not_run" });
      continue;
    }
    if (plan.state === "build_failed") {
      errors.push(`"${term}": ${plan.error}`);
      outcomes.push({ term, budget, scraped: 0, status: "failed" });
      continue;
    }
    const termResults = plan.runs.map((runIndex) => ({
      result: results[runIndex],
      cap: runs[runIndex].cap,
    }));
    if (termResults.every(({ result }) => result === undefined)) {
      outcomes.push({ term, budget, scraped: 0, status: "not_run" });
      continue;
    }
    const termErrors: string[] = [];
    let scraped = 0;
    let stoppedEarly = false;
    let reachedCap = false;
    let unsearched = 0;
    for (const { result, cap } of termResults) {
      if (result === undefined) {
        unsearched += 1;
      } else if (result.kind === "error") {
        termErrors.push(result.error);
      } else {
        jobs.push(...result.mapped);
        droppedCount += result.droppedCount;
        scraped += result.outcome.items.length;
        if (result.outcome.items.length >= cap) reachedCap = true;
        if (result.outcome.stoppedEarly) stoppedEarly = true;
        else if (result.outcome.status !== "SUCCEEDED") {
          termErrors.push(
            describeUnfinishedRun(
              result.outcome.status,
              result.outcome.items.length,
              result.mapped.length,
            ),
          );
        }
      }
    }
    if (unsearched > 0) {
      termErrors.push(
        `${unsearched} of its ${termResults.length} searches were not run`,
      );
    }
    if (termErrors.length > 0) {
      errors.push(`"${term}": ${termErrors.join("; ")}`);
      outcomes.push({ term, budget, scraped, status: "failed" });
    } else if (stoppedEarly) {
      outcomes.push({ term, budget, scraped, status: "stopped" });
    } else {
      outcomes.push({
        term,
        budget,
        scraped,
        status: reachedCap ? "capped" : "under",
      });
    }
  }

  const notRun = outcomes.filter((outcome) => outcome.status === "not_run");
  if (notRun.length > 0) {
    errors.push(`${notRun.length} search term(s) were not searched`);
  }
  return errors.length > 0
    ? {
        success: false,
        jobs,
        droppedCount,
        termBudgets: outcomes,
        error: errors.join("; "),
      }
    : { success: true, jobs, droppedCount, termBudgets: outcomes };
}

async function runApifyInstance(
  context: ProviderRunContext,
): Promise<ExtractorRunResult> {
  const { instance, apiToken, shouldCancel } = context;

  if (shouldCancel?.()) {
    return { success: true, jobs: [] };
  }

  if (!apiToken) {
    return {
      success: false,
      jobs: [],
      error: "Apify API token is not configured. Add it on the Sources tab.",
    };
  }

  const template = instance.templateId
    ? findApifyTemplate(instance.templateId)
    : undefined;

  if (instance.templateId && !template) {
    return {
      success: false,
      jobs: [],
      error: `Unknown Apify template id: ${instance.templateId}`,
    };
  }

  if (template?.perTermRuns) return runPerTerm(context, template);
  return runOnce(context, template);
}

export const apifyProvider: ProviderRunner = {
  id: "apify",
  displayName: "Apify",
  templates: APIFY_TEMPLATES,
  run: runApifyInstance,
};
