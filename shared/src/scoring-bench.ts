/**
 * Pure summarisation of a benchmark run. Lives in shared/ with no DOM and no
 * server imports so the arithmetic can be tested on its own — the panel only
 * renders what these functions return.
 */

import {
  SUITABILITY_CATEGORY_RANK,
  type SuitabilityCategory,
} from "./types/jobs";
import type { BenchCell, BenchConfig, BenchJob } from "./types/scoring-bench";

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
  if (referenceConfigId !== null && referenceConfigId !== configId) {
    for (const cell of classifiedCells) {
      const reference = byKey.get(cellKey(cell.jobId, referenceConfigId));
      if (!reference?.category || !cell.category) continue;
      comparable += 1;
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

  return {
    configId,
    classified: classifiedCells.length,
    failed: own.filter((cell) => cell.status === "error").length,
    comparable,
    agreement: comparable > 0 ? exact / comparable : null,
    withinOneTier: comparable > 0 ? withinOne / comparable : null,
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
 * How many jobs each column put in each category. The summary reads down these
 * to answer "is the cheap model just harsher across the board?", which an
 * agreement percentage alone cannot show.
 */
export function categoryCounts(
  cells: BenchCell[],
  configId: string,
): Record<SuitabilityCategory, number> {
  const counts: Record<SuitabilityCategory, number> = {
    great_fit: 0,
    very_good_fit: 0,
    good_fit: 0,
    bad_fit: 0,
  };
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
