import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
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

// The stored template substituted from the live run context, then handed to
// the template's `buildInput` hook when it has one.
function buildActorInput(
  context: ProviderRunContext,
  template: ProviderActorTemplate | undefined,
): Built<unknown> {
  const { instance, runGlobals, searchTerms } = context;
  let resolvedInput: unknown;
  try {
    resolvedInput = substituteInputTemplate({
      templateJson: instance.inputTemplateJson,
      runGlobals,
      searchTerms,
      placeholderMinimums: template?.placeholderMinimums,
      maxJobs: instance.maxJobs,
      maxAgeDays: instance.maxAgeDays,
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof TemplateSubstitutionError
          ? error.message
          : errorMessage(error, "Failed to substitute input template"),
    };
  }

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

/**
 * One actor run per search term, one after another in the run's term order,
 * each capped at that term's budget.
 *
 * - A run that throws (a FAILED run, an API error) stops the sequence: those
 *   are usually account-wide and would fail every later term the same way.
 * - A run that times out is about its own term: its rows are kept, the term
 *   is `failed`, and the next term runs.
 * - A cancel stops the sequence after the term in flight. Mapping stops at a
 *   cancel, as it does for a single run, so that term keeps no rows.
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
  const outcomes: TermBudgetOutcome[] = [];
  const jobs: CreateJobInput[] = [];
  const errors: string[] = [];
  let droppedCount = 0;
  let stopped = false;

  const report = (termsProcessed: number, detail: string) =>
    onProgress?.({
      termsProcessed,
      termsTotal: terms.length,
      // Sent as a pair: the live line reads "processed/enqueued", and there
      // is no separate count of pages queued for an actor run.
      jobPagesEnqueued: jobs.length,
      jobPagesProcessed: jobs.length,
      detail,
    });

  report(0, `${context.instance.label}: 0/${terms.length} search terms`);

  for (const [index, term] of terms.entries()) {
    const budget = termBudgetFor(context, template, term);
    if (stopped || shouldCancel?.()) {
      stopped = true;
      outcomes.push({ term, budget, scraped: 0, status: "not_run" });
      continue;
    }

    const termContext: ProviderRunContext = {
      ...context,
      searchTerms: [term],
      termBudget: budget,
    };
    const fail = (error: string, scraped: number) => {
      errors.push(`"${term}": ${error}`);
      outcomes.push({ term, budget, scraped, status: "failed" });
    };

    const input = buildActorInput(termContext, template);
    if (!input.ok) {
      fail(input.error, 0);
      stopped = true;
      continue;
    }

    let runOutcome: ApifyRunOutcome;
    try {
      runOutcome = await runApifyActor({
        token: context.apiToken ?? "",
        actorRef: context.instance.actorRef,
        input: input.value,
        shouldCancel,
        watch: termStopWatch(context, template, term, input.value),
      });
    } catch (error) {
      fail(errorMessage(error, String(error)), 0);
      stopped = true;
      continue;
    }

    const mapping = mapDatasetItems(termContext, template, runOutcome.items);
    if (!mapping.ok) {
      fail(mapping.error, 0);
      stopped = true;
      continue;
    }
    jobs.push(...mapping.value.mapped);
    droppedCount += mapping.value.droppedCount;
    const scraped = runOutcome.items.length;

    if (runOutcome.stoppedEarly) {
      outcomes.push({ term, budget, scraped, status: "stopped" });
    } else if (runOutcome.status === "SUCCEEDED") {
      outcomes.push({
        term,
        budget,
        scraped,
        status: scraped >= budget ? "capped" : "under",
      });
    } else {
      fail(
        describeUnfinishedRun(
          runOutcome.status,
          scraped,
          mapping.value.mapped.length,
        ),
        scraped,
      );
      // No stop here: a cancel behind this abort is caught at the top of the
      // next turn, and an abort the client made because this run overran its
      // own timeout is about this term alone.
    }
    report(
      index + 1,
      `${context.instance.label}: ${index + 1}/${terms.length} search terms`,
    );
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
