/**
 * Pure summarisation of a benchmark run. Lives in shared/ with no DOM and no
 * server imports so the arithmetic can be tested on its own — the panel only
 * renders what these functions return.
 */

import {
  SUITABILITY_CATEGORIES,
  SUITABILITY_CATEGORY_RANK,
  type SuitabilityCategory,
} from "./types/jobs";
import type { BenchCell, BenchConfig, BenchJob } from "./types/scoring-bench";

/**
 * The tiers whose loss decides whether a column can be used as a pre-filter.
 * A screen's single power is to send a job to `bad_fit` and stop, so a wrongly
 * screened `good_fit` is a borderline call, while a wrongly screened
 * `great_fit` / `very_good_fit` is a job the user never sees at all. The two are
 * reported separately because only the second one disqualifies a screen.
 */
export const TOP_FIT_CATEGORIES = [
  "great_fit",
  "very_good_fit",
] as const satisfies readonly SuitabilityCategory[];

/**
 * One home for the four keys, so a fifth tier breaks the build here rather than
 * being silently absent from a tally somewhere.
 */
function emptyCategoryTally(): Record<SuitabilityCategory, number> {
  return { great_fit: 0, very_good_fit: 0, good_fit: 0, bad_fit: 0 };
}

function isBadFit(category: SuitabilityCategory): boolean {
  return category === "bad_fit";
}

function sumOver(
  tally: Record<SuitabilityCategory, number>,
  categories: readonly SuitabilityCategory[],
): number {
  return categories.reduce((total, category) => total + tally[category], 0);
}

/** Null rather than NaN when nothing qualified — an absent rate is not 0%. */
function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export interface ConfigSummary {
  configId: string;
  /** Cells that produced a category. */
  classified: number;
  failed: number;
  /**
   * Share of jobs where this config agreed exactly with the reference,
   * counted over jobs BOTH classified. Null for the reference itself, and
   * null when they share no successfully classified job.
   */
  agreement: number | null;
  /** Same denominator as `agreement`, but counting a one-tier gap as a match. */
  withinOneTier: number | null;
  /** Jobs both classified — the denominator behind the two rates above. */
  comparable: number;
  /**
   * Comparable jobs grouped by what the BASELINE said, and — of those — how
   * many THIS column called `bad_fit`. Together they are the `bad_fit` column of
   * the confusion matrix, which is the only part a pre-filter can act on, so
   * every screening figure (`screenLoss`, `binaryAgreement`) derives from these
   * two rather than being counted separately.
   */
  comparableByReferenceCategory: Record<SuitabilityCategory, number>;
  calledBadByReferenceCategory: Record<SuitabilityCategory, number>;
  /**
   * Share of comparable jobs where this column and the baseline agreed on bad
   * vs not-bad, whatever non-bad tier each chose. Null under the same
   * conditions as `agreement`.
   */
  binaryAgreement: number | null;
  /**
   * Share of this column's OWN classified jobs that it called non-bad — what a
   * pre-filter built on it would forward to the expensive model. The
   * denominator is deliberately not `comparable`: this is a volume figure, and
   * a job the baseline never classified still costs a second call.
   */
  passRate: number | null;
  /**
   * Mean input and output tokens per classified job, over the cells that
   * reported each. Null when the provider reported none (codex reports no usage
   * at all), which is deliberately distinct from 0.
   */
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
  /**
   * What the reported usage cost at the configured per-million rates, and the
   * same figure per job. BOTH are computed over the cells that actually
   * reported usage — mixing a usage-only numerator with an all-jobs divisor
   * would understate per-job cost, and every multiplier built on it. Null when
   * the column carries no rates or the provider reported nothing; an absent
   * estimate is never rendered as 0, which would read as "free".
   */
  estimatedCost: number | null;
  estimatedCostPerJob: number | null;
  /** Cells behind the two figures above — the honest denominator. */
  pricedJobs: number;
  /**
   * True when a rate was given for a half the provider never reported, so the
   * estimate covers only part of the spend.
   */
  partialEstimate: boolean;
  /** Mean wall-clock per classified cell, milliseconds. */
  avgDurationMs: number | null;
}

export interface DisagreementRow {
  job: BenchJob;
  /** Cells for this job, ordered to match the run's config order. */
  cells: BenchCell[];
}

/**
 * Cell identity. Exported so callers look a cell up with the SAME builder the
 * index was written with — a hand-rolled template literal at a call site is
 * exactly how a lookup silently misses every row.
 */
export function cellKey(jobId: string, configId: string): string {
  return `${jobId}::${configId}`;
}

/**
 * Column id for what is already saved on each job. It is modelled as a
 * synthetic config so every function here — agreement, disagreements, the
 * summary — treats "the database" as just another column, instead of each
 * caller special-casing it.
 */
export const STORED_COLUMN_ID = "__stored__";

export const STORED_COLUMN: BenchConfig = {
  id: STORED_COLUMN_ID,
  label: "Saved in database",
  model: "",
  effort: null,
  // No rates: what a past run cost is not something this screen can know.
  inputCostPerMillion: null,
  outputCostPerMillion: null,
};

/**
 * Cells for the saved-value column. A job that has never been classified
 * yields a cell with no category, which every rate here already excludes from
 * its denominator — the same treatment a model that failed on that job gets.
 */
export function buildStoredCells(jobs: BenchJob[]): BenchCell[] {
  return jobs.map((job) => ({
    jobId: job.id,
    configId: STORED_COLUMN_ID,
    status: job.storedCategory ? ("done" as const) : ("pending" as const),
    category: job.storedCategory,
    reason: job.storedReason,
    error: null,
    promptTokens: null,
    completionTokens: null,
    durationMs: null,
  }));
}

/**
 * The line under a column's name. Shared because this is rendered in three
 * places and the saved column has no model to name — printing its empty model
 * as "provider default" would claim the database's value came from the
 * provider's default model.
 */
export function configSubtitle(config: BenchConfig): string {
  if (config.id === STORED_COLUMN_ID) return "saved on the job";
  const model = config.model || "provider default";
  return config.effort ? `${model} · ${config.effort}` : model;
}

export function indexCells(cells: BenchCell[]): Map<string, BenchCell> {
  const byKey = new Map<string, BenchCell>();
  for (const cell of cells) {
    byKey.set(cellKey(cell.jobId, cell.configId), cell);
  }
  return byKey;
}

function sum(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function summarizeConfig(args: {
  configId: string;
  referenceConfigId: string | null;
  cells: BenchCell[];
  /** Per-million prices for this column; omit for no cost estimate. */
  rates?: { input: number | null; output: number | null };
  /**
   * Prebuilt index of the same cells. Optional, but a caller summarising every
   * config of a streaming run should pass one: without it each config re-indexes
   * the whole grid on every incoming cell.
   */
  index?: Map<string, BenchCell>;
}): ConfigSummary {
  const { configId, referenceConfigId } = args;
  const byKey = args.index ?? indexCells(args.cells);
  const own = args.cells.filter((cell) => cell.configId === configId);

  const classifiedCells = own.filter((cell) => cell.category !== null);
  // Each half is averaged over the cells that reported THAT half, so a provider
  // reporting only one of the two still contributes the number it does report
  // instead of being averaged against an invented zero.
  const promptValues = classifiedCells
    .map((cell) => cell.promptTokens)
    .filter((value): value is number => value !== null);
  const completionValues = classifiedCells
    .map((cell) => cell.completionTokens)
    .filter((value): value is number => value !== null);
  const durationValues = classifiedCells
    .map((cell) => cell.durationMs)
    .filter((value): value is number => value !== null);

  let comparable = 0;
  let exact = 0;
  let withinOne = 0;
  const comparableByReferenceCategory = emptyCategoryTally();
  const calledBadByReferenceCategory = emptyCategoryTally();
  if (referenceConfigId !== null && referenceConfigId !== configId) {
    for (const cell of classifiedCells) {
      const reference = byKey.get(cellKey(cell.jobId, referenceConfigId));
      if (!reference?.category || !cell.category) continue;
      comparable += 1;
      comparableByReferenceCategory[reference.category] += 1;
      if (isBadFit(cell.category)) {
        calledBadByReferenceCategory[reference.category] += 1;
      }
      if (reference.category === cell.category) {
        exact += 1;
        withinOne += 1;
        continue;
      }
      const gap = Math.abs(
        SUITABILITY_CATEGORY_RANK[reference.category] -
          SUITABILITY_CATEGORY_RANK[cell.category],
      );
      if (gap <= 1) withinOne += 1;
    }
  }

  // The set the sums cover: a cell counts once if it reported either half.
  const pricedJobs = classifiedCells.filter(
    (cell) => cell.promptTokens !== null || cell.completionTokens !== null,
  ).length;
  const cost = estimateCost({
    promptTokens: sum(promptValues),
    completionTokens: sum(completionValues),
    rates: args.rates,
  });
  const partialEstimate =
    cost !== null &&
    ((args.rates?.input != null && promptValues.length === 0) ||
      (args.rates?.output != null && completionValues.length === 0));

  // Derived from the tallies instead of counted beside them, so the binary view
  // and the per-tier view cannot drift apart: a job matches when the baseline
  // called it bad and this column did too, or when neither did.
  const binaryMatches = SUITABILITY_CATEGORIES.reduce((total, category) => {
    const inBucket = comparableByReferenceCategory[category];
    const calledBad = calledBadByReferenceCategory[category];
    return total + (isBadFit(category) ? calledBad : inBucket - calledBad);
  }, 0);

  const nonBadOwn = classifiedCells.filter(
    (cell) => cell.category !== null && !isBadFit(cell.category),
  ).length;

  return {
    configId,
    classified: classifiedCells.length,
    failed: own.filter((cell) => cell.status === "error").length,
    comparable,
    agreement: comparable > 0 ? exact / comparable : null,
    withinOneTier: comparable > 0 ? withinOne / comparable : null,
    comparableByReferenceCategory,
    calledBadByReferenceCategory,
    binaryAgreement: rate(binaryMatches, comparable),
    passRate: rate(nonBadOwn, classifiedCells.length),
    avgPromptTokens: mean(promptValues),
    avgCompletionTokens: mean(completionValues),
    estimatedCost: cost,
    estimatedCostPerJob:
      cost === null || pricedJobs === 0 ? null : cost / pricedJobs,
    pricedJobs,
    partialEstimate,
    avgDurationMs: mean(durationValues),
  };
}

/**
 * Priced from the tokens actually reported, so a column whose provider reports
 * nothing yields null rather than a confident zero. Rates are per million.
 */
function estimateCost(args: {
  promptTokens: number | null;
  completionTokens: number | null;
  rates?: { input: number | null; output: number | null };
}): number | null {
  const { rates } = args;
  if (!rates) return null;
  if (rates.input === null && rates.output === null) return null;
  if (args.promptTokens === null && args.completionTokens === null) return null;

  return (
    ((args.promptTokens ?? 0) * (rates.input ?? 0)) / 1_000_000 +
    ((args.completionTokens ?? 0) * (rates.output ?? 0)) / 1_000_000
  );
}

/**
 * What using a column as a pre-filter in front of the baseline would cost the
 * user, split by how much the loss matters. Read it as: of the jobs the
 * baseline rated, how many would this column have thrown away before the
 * baseline ever saw them.
 */
export interface ScreenLoss {
  /** Baseline `great_fit` + `very_good_fit` among the comparable jobs. */
  topComparable: number;
  /** Of those, how many this column called `bad_fit` — the unacceptable loss. */
  topLost: number;
  topKeptRate: number | null;
  /** The same three for baseline `good_fit`, where loss is a judgement call. */
  goodComparable: number;
  goodLost: number;
  goodKeptRate: number | null;
  /** Baseline `bad_fit`, and how much of it this column would remove — the win. */
  badComparable: number;
  badScreened: number;
  badScreenedRate: number | null;
}

export function screenLoss(summary: ConfigSummary): ScreenLoss {
  const comparable = summary.comparableByReferenceCategory;
  const calledBad = summary.calledBadByReferenceCategory;

  const topComparable = sumOver(comparable, TOP_FIT_CATEGORIES);
  const topLost = sumOver(calledBad, TOP_FIT_CATEGORIES);
  const goodComparable = comparable.good_fit;
  const goodLost = calledBad.good_fit;
  const badComparable = comparable.bad_fit;
  const badScreened = calledBad.bad_fit;

  return {
    topComparable,
    topLost,
    topKeptRate: rate(topComparable - topLost, topComparable),
    goodComparable,
    goodLost,
    goodKeptRate: rate(goodComparable - goodLost, goodComparable),
    badComparable,
    badScreened,
    badScreenedRate: rate(badScreened, badComparable),
  };
}

/**
 * Cost per job of screening with this column and classifying the survivors with
 * the baseline: every job pays the screen, and `passRate` of them pay the
 * baseline as well. Null unless both columns carry a cost estimate — the point
 * of the figure is the comparison, and a half-priced one would mislead.
 *
 * It is an optimistic floor by construction: a job the screen fails on falls
 * through to the baseline (the screen must never delete jobs), so a column with
 * a meaningful failure rate costs more in practice than this says.
 */
export function projectedGateCostPerJob(
  candidate: ConfigSummary,
  baseline: ConfigSummary | undefined,
): number | null {
  const screenCost = candidate.estimatedCostPerJob;
  const baselineCost = baseline?.estimatedCostPerJob;
  if (screenCost === null) return null;
  if (baselineCost === undefined || baselineCost === null) return null;
  if (candidate.passRate === null) return null;
  return screenCost + candidate.passRate * baselineCost;
}

/** The same figure against classifying everything with the baseline. */
export function projectedGateCostMultiplier(
  candidate: ConfigSummary,
  baseline: ConfigSummary | undefined,
): number | null {
  const projected = projectedGateCostPerJob(candidate, baseline);
  const baselineCost = baseline?.estimatedCostPerJob;
  if (projected === null) return null;
  if (
    baselineCost === undefined ||
    baselineCost === null ||
    baselineCost === 0
  ) {
    return null;
  }
  return projected / baselineCost;
}

/**
 * How much dearer this column is than the reference, per classified job. Null
 * unless both sides carry an estimate — a ratio against an unpriced column
 * would be meaningless rather than infinite.
 */
export function costMultiplier(
  summary: ConfigSummary,
  reference: ConfigSummary | undefined,
): number | null {
  const own = summary.estimatedCostPerJob;
  const base = reference?.estimatedCostPerJob;
  if (own === null || base === undefined || base === null || base === 0) {
    return null;
  }
  return own / base;
}

/**
 * Jobs where the configs did not all land on the same category. Only cells that
 * produced a category count: a job that one config failed on is not a
 * disagreement, it is a gap, and calling it one would inflate the number the
 * user reads as "the models differ here".
 */
export function findDisagreements(args: {
  jobs: BenchJob[];
  configs: BenchConfig[];
  cells: BenchCell[];
  /** Prebuilt index of the same cells; see `summarizeConfig`. */
  index?: Map<string, BenchCell>;
}): DisagreementRow[] {
  const byKey = args.index ?? indexCells(args.cells);
  const rows: DisagreementRow[] = [];

  for (const job of args.jobs) {
    const cells = args.configs
      .map((config) => byKey.get(cellKey(job.id, config.id)))
      .filter((cell): cell is BenchCell => cell !== undefined);
    const categories = cells
      .map((cell) => cell.category)
      .filter(
        (category): category is NonNullable<typeof category> =>
          category !== null,
      );
    if (categories.length < 2) continue;
    if (new Set(categories).size < 2) continue;
    rows.push({ job, cells });
  }

  return rows;
}

/**
 * The subset of disagreements that cross the bad / not-bad line. Those are the
 * only ones a pre-filter could act on — a great_fit-vs-good_fit split changes
 * the ranking but not whether the job survives — so reviewing them is how the
 * jobs a screen would have thrown away actually get read.
 */
export function filterBinaryCrossings(
  rows: DisagreementRow[],
): DisagreementRow[] {
  return rows.filter((row) => {
    let sawBad = false;
    let sawNonBad = false;
    for (const cell of row.cells) {
      if (cell.category === null) continue;
      if (isBadFit(cell.category)) sawBad = true;
      else sawNonBad = true;
    }
    return sawBad && sawNonBad;
  });
}

/**
 * How many jobs each column put in each category. The summary reads down these
 * to answer "is the cheap model just harsher across the board?", which an
 * agreement percentage alone cannot show.
 */
export function categoryCounts(
  cells: BenchCell[],
  configId: string,
): Record<SuitabilityCategory, number> {
  const counts = emptyCategoryTally();
  for (const cell of cells) {
    if (cell.configId !== configId || !cell.category) continue;
    counts[cell.category] += 1;
  }
  return counts;
}

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}
