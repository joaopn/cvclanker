import type { ClaudeCodeEffortLevel } from "../settings-registry";
import type { SuitabilityCategory } from "./jobs";

/**
 * What a sample may be drawn from. Mirrors the Manage view's fit chips, so
 * "unscored" is a first-class choice rather than an absence — a job that has
 * never been classified is exactly the kind you may want to benchmark on.
 */
export type BenchSampleCategory = SuitabilityCategory | "unscored";

/**
 * One model configuration under test. `label` is user-supplied and free — two
 * rows may carry the SAME model and effort on purpose, because running one
 * model against itself is the only way to tell a real disagreement apart from
 * sampling noise.
 *
 * There is no provider field: a benchmark runs entirely on the configured
 * provider, so the only credentials involved are the ones already saved.
 */
export interface BenchConfig {
  id: string;
  label: string;
  /**
   * Resolved server-side before the first call: a request may leave this blank
   * to mean "whatever model scoring uses today", but a run always records the
   * model it actually sent.
   */
  model: string;
  /**
   * claude_code only, and likewise resolved: null on a stored run means no
   * `--effort` flag was sent, NOT "some default we didn't look up".
   */
  effort: ClaudeCodeEffortLevel | null;
  /**
   * Price per million tokens, in whatever currency the user typed. Optional and
   * uncached-rate by convention: providers that discount cached input are not
   * modelled, so an estimate built from these is an upper bound on input spend.
   * Null means "no estimate for this column" rather than "free".
   */
  inputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
}

/** A job drawn into the sample. Enough to render a row, no description. */
export interface BenchJob {
  id: string;
  title: string;
  employer: string;
  jobUrl: string | null;
  /** What is saved on the job today; null when it has never been classified. */
  storedCategory: SuitabilityCategory | null;
  storedReason: string | null;
}

export type BenchCellStatus = "pending" | "running" | "done" | "error";

/** One (job, config) classification. */
export interface BenchCell {
  jobId: string;
  configId: string;
  status: BenchCellStatus;
  category: SuitabilityCategory | null;
  reason: string | null;
  error: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  durationMs: number | null;
}

export type BenchRunStatus = "running" | "done" | "cancelled" | "stopped";

export interface BenchRun {
  id: string;
  status: BenchRunStatus;
  /** Set when status is "stopped" — e.g. the provider rate-limited everything. */
  stoppedReason: string | null;
  configs: BenchConfig[];
  jobs: BenchJob[];
  cells: BenchCell[];
  /** The fit categories the sample was drawn from, as requested. */
  sampleCategories: BenchSampleCategory[];
  startedAt: string;
  finishedAt: string | null;
}

export type BenchStreamEvent =
  | { type: "snapshot"; run: BenchRun | null }
  | { type: "cell"; runId: string; cell: BenchCell }
  | {
      type: "status";
      runId: string;
      status: BenchRunStatus;
      stoppedReason: string | null;
      finishedAt: string | null;
    };

export interface StartBenchRunInput {
  sampleSize: number;
  /** Restricts the draw. Every category selected (the default) means no filter. */
  categories?: BenchSampleCategory[];
  configs: Array<{
    label: string;
    /** Blank means "the model scoring uses today"; the server resolves it. */
    model: string;
    effort?: ClaudeCodeEffortLevel | null;
    inputCostPerMillion?: number | null;
    outputCostPerMillion?: number | null;
  }>;
}
