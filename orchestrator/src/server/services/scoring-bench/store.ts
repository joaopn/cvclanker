/**
 * In-memory home for the model benchmark. One run at a time, held for the life
 * of the process: a benchmark writes nothing to the database, so a finished run
 * survives a page reload (the client re-attaches to the stream and replays the
 * snapshot) but is deliberately gone after a restart.
 *
 * Shaped after `pipeline/progress.ts`: a replayable snapshot plus a listener
 * set, so the SSE route is only a viewer and closing the page never cancels
 * anything.
 */

import { randomUUID } from "node:crypto";
import type {
  BenchCell,
  BenchConfig,
  BenchJob,
  BenchRun,
  BenchRunStatus,
  BenchSampleCategory,
  BenchStreamEvent,
} from "@shared/types";

type Listener = (event: BenchStreamEvent) => void;

const listeners = new Set<Listener>();

let currentRun: BenchRun | null = null;
/** Set by a cancel request or by a rate-limit stop; read by the runner's pool. */
let stopRequested = false;
let stopReason: string | null = null;

function emit(event: BenchStreamEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must not take the run down with it.
    }
  }
}

export function subscribeToBenchRun(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCurrentBenchRun(): BenchRun | null {
  return currentRun;
}

export function isBenchRunActive(): boolean {
  return currentRun?.status === "running";
}

/**
 * Compare-and-set claim, synchronous by contract: the caller must invoke this
 * BEFORE its first await, or two concurrent POSTs both read "idle" and both
 * start a run. Returns the seeded run, or null when one is already active.
 */
export function claimBenchRun(
  configs: BenchConfig[],
  sampleCategories: BenchSampleCategory[],
): BenchRun | null {
  if (isBenchRunActive()) return null;

  stopRequested = false;
  stopReason = null;
  currentRun = {
    id: randomUUID(),
    status: "running",
    stoppedReason: null,
    configs,
    jobs: [],
    cells: [],
    sampleCategories,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  emit({ type: "snapshot", run: currentRun });
  return currentRun;
}

/**
 * Attach the drawn sample and seed a pending cell per (job, config). Emitting a
 * fresh snapshot rather than per-cell events keeps a re-attaching client from
 * having to assemble the grid itself.
 */
export function setBenchRunJobs(runId: string, jobs: BenchJob[]): void {
  const run = currentRun;
  if (!run || run.id !== runId) return;
  run.jobs = jobs;
  run.cells = jobs.flatMap((job) =>
    run.configs.map((config) => ({
      jobId: job.id,
      configId: config.id,
      status: "pending" as const,
      category: null,
      reason: null,
      error: null,
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
    })),
  );
  emit({ type: "snapshot", run });
}

/**
 * Replace the run's configurations with what will ACTUALLY be sent to the
 * provider (a blank model resolved to the configured scoring model, a blank
 * effort resolved to the configured one). The grid labels its columns from
 * these, so leaving them blank would let a column headed "no effort" have run
 * at the saved effort — a wrong conclusion in the one place the feature exists
 * to draw conclusions.
 */
export function setBenchRunConfigs(
  runId: string,
  configs: BenchConfig[],
): void {
  const run = currentRun;
  if (!run || run.id !== runId) return;
  run.configs = configs;
  emit({ type: "snapshot", run });
}

export function recordBenchCell(runId: string, cell: BenchCell): void {
  if (!currentRun || currentRun.id !== runId) return;
  const index = currentRun.cells.findIndex(
    (existing) =>
      existing.jobId === cell.jobId && existing.configId === cell.configId,
  );
  if (index === -1) currentRun.cells.push(cell);
  else currentRun.cells[index] = cell;
  emit({ type: "cell", runId, cell });
}

export function finishBenchRun(
  runId: string,
  status: Exclude<BenchRunStatus, "running">,
  reason: string | null = null,
): void {
  if (!currentRun || currentRun.id !== runId) return;
  currentRun.status = status;
  currentRun.stoppedReason = reason;
  currentRun.finishedAt = new Date().toISOString();
  emit({
    type: "status",
    runId,
    status,
    stoppedReason: reason,
    finishedAt: currentRun.finishedAt,
  });
}

/** User pressed Cancel. Returns false when there was nothing to cancel. */
export function requestBenchCancel(): boolean {
  if (!isBenchRunActive()) return false;
  stopRequested = true;
  return true;
}

/**
 * Stop for a reason that is not the user's doing — today only a provider rate
 * limit, which is account-wide, so every remaining cell would hit the same wall.
 */
export function requestBenchStop(reason: string): void {
  stopRequested = true;
  stopReason = reason;
}

export function isBenchStopRequested(): boolean {
  return stopRequested;
}

export function getBenchStopReason(): string | null {
  return stopReason;
}

/** Test-only: drop all state so files don't leak runs into each other. */
export function resetBenchStoreForTests(): void {
  currentRun = null;
  stopRequested = false;
  stopReason = null;
  listeners.clear();
}
