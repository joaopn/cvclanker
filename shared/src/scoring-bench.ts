/**
 * Pure summarisation of a benchmark run. Lives in shared/ with no DOM and no
 * server imports so the arithmetic can be tested on its own — the panel only
 * renders what these functions return.
 */

import { SUITABILITY_CATEGORY_RANK } from "./types/jobs";
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
   * Mean of (promptTokens + completionTokens) over cells that reported usage.
   * Null when the provider reports none (codex reports no usage at all), which
   * is deliberately distinct from 0.
   */
  avgTotalTokens: number | null;
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

export function indexCells(cells: BenchCell[]): Map<string, BenchCell> {
  const byKey = new Map<string, BenchCell>();
  for (const cell of cells) {
    byKey.set(cellKey(cell.jobId, cell.configId), cell);
  }
  return byKey;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function summarizeConfig(args: {
  configId: string;
  referenceConfigId: string | null;
  cells: BenchCell[];
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
  const tokenValues: number[] = [];
  for (const cell of classifiedCells) {
    // A provider reporting neither count contributes nothing; one that reports
    // only completion tokens still carries real information, so treat the
    // missing half as 0 rather than dropping the cell.
    if (cell.promptTokens === null && cell.completionTokens === null) continue;
    tokenValues.push((cell.promptTokens ?? 0) + (cell.completionTokens ?? 0));
  }
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

  return {
    configId,
    classified: classifiedCells.length,
    failed: own.filter((cell) => cell.status === "error").length,
    comparable,
    agreement: comparable > 0 ? exact / comparable : null,
    withinOneTier: comparable > 0 ? withinOne / comparable : null,
    avgTotalTokens: mean(tokenValues),
    avgDurationMs: mean(durationValues),
  };
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

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}
