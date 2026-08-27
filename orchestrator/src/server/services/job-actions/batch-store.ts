/**
 * In-memory registry of bulk job-action batches, detached from the request that
 * started them.
 *
 * Shaped after `services/scoring-bench/store.ts` and `pipeline/progress.ts`: a
 * replayable snapshot plus a listener set, so an SSE route is only a viewer and
 * closing the page never cancels anything. One departure from the bench store —
 * it claims a singleton run, and this cannot: the Swipe deck fires one action
 * per swipe, so a singleton would reject rapid swipes.
 *
 * Nothing here is persisted. A restart loses every record, which is why the
 * snapshot is a COMPLETE enumeration of what is retained: it is the only way a
 * client can tell "finished and evicted" from "lost with the process".
 */

import { randomUUID } from "node:crypto";
import { logger } from "@infra/logger";
import { asyncPool } from "@server/utils/async-pool";
import type {
  JobAction,
  JobActionBatchItemOutcome,
  JobActionBatchSnapshot,
  JobActionBatchStatus,
  JobActionResult,
} from "@shared/types";

/**
 * How many finished batches stay readable. Mirrors the LLM call observer's
 * window deliberately rather than picking a fresh number: retention has to
 * outlive the gap between a POST and the viewer opening, and a page reload with
 * an unread summary. At 5, a burst of swipes — one batch each — would evict an
 * unread bulk summary within seconds; at 500 the retained failedJobIds arrays
 * (up to `maxBulkActionJobs` ids apiece) stop being bounded in any useful sense.
 */
export const MAX_RETAINED_TERMINAL_BATCHES = 50;

export interface JobActionBatchOutcome {
  status: Exclude<JobActionBatchStatus, "running">;
  results: JobActionResult[];
  error: Error | null;
}

interface BatchUpdate {
  batch: JobActionBatchSnapshot;
  lastResult?: JobActionBatchItemOutcome;
}

type Listener = (update: BatchUpdate) => void;

interface BatchRecord {
  id: string;
  action: JobAction;
  status: JobActionBatchStatus;
  /**
   * Every job id the batch was asked to act on, deduped, claimed while it
   * runs, and cleared at terminal — nothing reads it afterwards and 50
   * retained batches would otherwise hold 50 x maxBulkActionJobs ids.
   */
  jobIds: string[];
  /** False for a caller that answers with the full result set itself. */
  cancellable: boolean;
  requested: number;
  completed: number;
  succeeded: number;
  failed: number;
  failedJobIds: string[];
  firstFailureMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
  /**
   * Full per-job results, keyed by job id so the batch can hand them back in
   * REQUEST order rather than completion order. Null unless a caller is
   * actually waiting for them: they carry whole `Job` rows, and a detached
   * batch of 1000 would otherwise hold tens of MB for nobody to read.
   */
  retainedResults: Map<string, JobActionResult> | null;
}

const batches = new Map<string, BatchRecord>();
const listeners = new Set<Listener>();

function toSnapshot(record: BatchRecord): JobActionBatchSnapshot {
  return {
    batchId: record.id,
    action: record.action,
    status: record.status,
    requested: record.requested,
    completed: record.completed,
    succeeded: record.succeeded,
    failed: record.failed,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    failedJobIds: [...record.failedJobIds],
    firstFailureMessage: record.firstFailureMessage,
  };
}

function emit(record: BatchRecord, lastResult?: JobActionBatchItemOutcome) {
  const update: BatchUpdate = lastResult
    ? { batch: toSnapshot(record), lastResult }
    : { batch: toSnapshot(record) };
  for (const listener of listeners) {
    try {
      listener(update);
    } catch {
      // A broken subscriber must not take the batch down with it.
    }
  }
}

/**
 * Drop the oldest finished records once too many have accumulated. RUNNING
 * records are never evicted: a live record that disappears takes its terminal
 * event with it, and every watcher of that batch then spins forever (the trap
 * the LLM call queue shipped as B13).
 */
function evictFinishedBatches() {
  const finished = [...batches.values()].filter(
    (record) => record.status !== "running",
  );
  if (finished.length <= MAX_RETAINED_TERMINAL_BATCHES) return;
  const stale = finished
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))
    .slice(0, finished.length - MAX_RETAINED_TERMINAL_BATCHES);
  for (const record of stale) {
    batches.delete(record.id);
  }
}

/** The complete set of retained batches, newest last. */
export function getJobActionBatches(): JobActionBatchSnapshot[] {
  return [...batches.values()]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map(toSnapshot);
}

export function subscribeToJobActionBatches(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Synchronous by contract. The DB-swap guards are atomic only because no await
 * sits between their check and `closeDb()`; an async read here would reopen the
 * very window this exists to close.
 */
export function hasRunningJobActionBatches(): boolean {
  for (const record of batches.values()) {
    if (record.status === "running") return true;
  }
  return false;
}

/** Whether any RUNNING batch is doing one of these actions. */
export function hasRunningJobActionBatchWithAction(
  actions: ReadonlySet<JobAction>,
): boolean {
  for (const record of batches.values()) {
    if (record.status === "running" && actions.has(record.action)) return true;
  }
  return false;
}

/** Job ids a RUNNING batch is acting on. Finished batches hold no claim. */
export function getClaimedJobIds(): Set<string> {
  const claimed = new Set<string>();
  for (const record of batches.values()) {
    if (record.status !== "running") continue;
    for (const jobId of record.jobIds) claimed.add(jobId);
  }
  return claimed;
}

/** User pressed Cancel. False when there was no running batch under that id. */
export function cancelJobActionBatch(batchId: string): boolean {
  const record = batches.get(batchId);
  if (!record || record.status !== "running") return false;
  if (!record.cancellable) return false;
  record.cancelRequested = true;
  return true;
}

export interface StartJobActionBatchInput {
  action: JobAction;
  jobIds: string[];
  concurrency: number;
  runJob: (jobId: string) => Promise<JobActionResult>;
  /**
   * Keep the full per-job results for `done`. Only the synchronous `/actions`
   * route needs them; a detached batch never reads them back.
   */
  retainResults?: boolean;
  /**
   * Whether `cancelJobActionBatch` may stop this batch. Defaults to true; a
   * caller that returns the full result set to its own requester sets false,
   * so nobody else can truncate that response.
   */
  cancellable?: boolean;
}

/**
 * Register a batch and start it detached. Returns immediately.
 *
 * `done` is for the caller that wants to wait (the synchronous `/actions`
 * route, which still answers with full results). It NEVER rejects — a detached
 * caller drops it on the floor, and an unhandled rejection there would take the
 * process down. Every exit writes a terminal status first, so a watcher always
 * gets its terminal event and the record always becomes evictable.
 */
export function startJobActionBatch(input: StartJobActionBatchInput): {
  batchId: string;
  done: Promise<JobActionBatchOutcome>;
} {
  const claimed = getClaimedJobIds();
  // Deduped HERE, not just at the routes: the results map is keyed by job id,
  // so a repeated id would count twice toward the counters while collapsing to
  // one result — a registry that says one job failed beside a response that
  // says none did.
  const jobIds = [...new Set(input.jobIds)];
  const record: BatchRecord = {
    id: randomUUID(),
    action: input.action,
    status: "running",
    jobIds,
    cancellable: input.cancellable !== false,
    requested: jobIds.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    failedJobIds: [],
    firstFailureMessage: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cancelRequested: false,
    retainedResults: input.retainResults ? new Map() : null,
  };
  batches.set(record.id, record);

  const recordResult = (result: JobActionResult) => {
    record.retainedResults?.set(result.jobId, result);
    record.completed += 1;
    if (result.ok) {
      record.succeeded += 1;
    } else {
      record.failed += 1;
      record.failedJobIds.push(result.jobId);
      if (record.firstFailureMessage === null) {
        record.firstFailureMessage = result.error.message;
      }
    }
    emit(record, {
      jobId: result.jobId,
      ok: result.ok,
      errorMessage: result.ok ? null : result.error.message,
    });
  };

  const finish = (
    status: Exclude<JobActionBatchStatus, "running">,
    error: Error | null,
  ): JobActionBatchOutcome => {
    record.status = status;
    record.finishedAt = new Date().toISOString();
    if (error && record.firstFailureMessage === null) {
      record.firstFailureMessage = error.message;
    }
    emit(record);
    evictFinishedBatches();
    // Rebuilt in REQUEST order. The pool settles out of order and contested
    // ids are recorded before it even starts, so completion order would
    // silently reshuffle a response callers index into positionally.
    const retained = record.retainedResults;
    const results = retained
      ? record.jobIds
          .map((jobId) => retained.get(jobId))
          .filter((result): result is JobActionResult => result !== undefined)
      : [];
    // Full rows are the starter's to keep; the registry stays counters-only.
    record.retainedResults = null;
    record.jobIds = [];
    return { status, results, error };
  };

  // A job another batch is already acting on is refused rather than dispatched
  // twice. The client's own in-flight lock is per-tab state and survives
  // neither a reload nor a second device, which is exactly this feature's
  // premise.
  const contested = jobIds.filter((jobId) => claimed.has(jobId));
  const dispatchable = jobIds.filter((jobId) => !claimed.has(jobId));
  for (const jobId of contested) {
    recordResult({
      jobId,
      ok: false,
      error: {
        code: "CONFLICT",
        message: "Another running batch is already acting on this job.",
      },
    });
  }

  const done = (async (): Promise<JobActionBatchOutcome> => {
    try {
      await asyncPool<string, void>({
        items: dispatchable,
        concurrency: input.concurrency,
        // Read between dispatches, so tasks already awaiting a provider run to
        // completion. Terminal is only written once the pool has resolved.
        shouldStop: () => record.cancelRequested,
        task: async (jobId) => {
          const result = await input.runJob(jobId);
          recordResult(result);
        },
      });
      return finish(record.cancelRequested ? "cancelled" : "completed", null);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Job action batch failed", {
        batchId: record.id,
        action: record.action,
        error: err.message,
      });
      return finish("failed", err);
    }
  })();

  return { batchId: record.id, done };
}

/** Test-only: drop all state so files don't leak batches into each other. */
export function resetJobActionBatchesForTests(): void {
  batches.clear();
  listeners.clear();
}
