/**
 * In-memory home for the batch URL import, detached from the request that
 * started it.
 *
 * ONE import at a time, unlike the job-action registry. The Swipe deck forced
 * a registry of N there — one batch per swipe; nothing analogous exists here,
 * because the import sheet is modal and you paste one list at a time. Being a
 * singleton is what bounds the snapshot by construction: one record of at most
 * `BATCH_URL_IMPORT_MAX_URLS` results, rather than a retention count to invent
 * for records that each carry their own results.
 *
 * Nothing is persisted; a restart loses the record. The finished one is kept
 * so a device arriving after the import ends can still read which URLs failed
 * and why — which is the whole reason this carries results at all.
 */

import { randomUUID } from "node:crypto";
import { logger } from "@infra/logger";
import { runBatchItems } from "@server/services/batches/run-batch-items";
import type {
  BatchUrlImportItemResult,
  JobActionBatchStatus,
  UrlImportBatchSnapshot,
} from "@shared/types";

type Listener = (batch: UrlImportBatchSnapshot) => void;

interface BatchRecord {
  id: string;
  status: JobActionBatchStatus;
  urls: string[];
  /** Keyed by url so the snapshot can be rebuilt in REQUEST order. */
  resultsByUrl: Map<string, BatchUrlImportItemResult>;
  succeeded: number;
  duplicates: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
}

let current: BatchRecord | null = null;
const listeners = new Set<Listener>();

function toSnapshot(record: BatchRecord): UrlImportBatchSnapshot {
  // Request order, not completion order: the sheet lists rows in the order the
  // user pasted them, and a table that reshuffles as results land is unreadable.
  const results = record.urls
    .map((url) => record.resultsByUrl.get(url))
    .filter(
      (result): result is BatchUrlImportItemResult => result !== undefined,
    );
  return {
    batchId: record.id,
    status: record.status,
    urls: [...record.urls],
    results,
    requested: record.urls.length,
    completed: results.length,
    succeeded: record.succeeded,
    duplicates: record.duplicates,
    failed: record.failed,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

function emit(record: BatchRecord) {
  const snapshot = toSnapshot(record);
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // A broken subscriber must not take the import down with it.
    }
  }
}

export function subscribeToUrlImportBatch(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUrlImportBatch(): UrlImportBatchSnapshot | null {
  return current ? toSnapshot(current) : null;
}

/**
 * Synchronous by contract. The DB-swap guards are atomic only because nothing
 * awaits between their check and `closeDb()`, and the rate-limit latch is read
 * the same way.
 */
export function isUrlImportRunning(): boolean {
  return current?.status === "running";
}

/** User pressed Stop. False when there was nothing running to stop. */
export function cancelUrlImportBatch(): boolean {
  if (!current || current.status !== "running") return false;
  current.cancelRequested = true;
  return true;
}

export interface StartUrlImportInput {
  urls: string[];
  concurrency: number;
  importUrl: (url: string) => Promise<BatchUrlImportItemResult>;
}

/**
 * Register the import and start it detached. Returns null when one is already
 * running — the caller answers 409.
 *
 * Claimed synchronously before the first await, or two concurrent POSTs both
 * read "idle" and start overlapping imports.
 */
export function startUrlImportBatch(
  input: StartUrlImportInput,
): { batchId: string; done: Promise<void> } | null {
  if (isUrlImportRunning()) return null;

  const record: BatchRecord = {
    id: randomUUID(),
    status: "running",
    urls: [...input.urls],
    resultsByUrl: new Map(),
    succeeded: 0,
    duplicates: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cancelRequested: false,
  };
  current = record;
  emit(record);

  const done = (async () => {
    const outcome = await runBatchItems({
      items: record.urls,
      concurrency: input.concurrency,
      isCancelled: () => record.cancelRequested,
      runItem: async (url) => {
        const result = await input.importUrl(url);
        record.resultsByUrl.set(url, result);
        if (result.ok && result.status === "created") record.succeeded += 1;
        else if (result.ok && result.status === "duplicate")
          record.duplicates += 1;
        else record.failed += 1;
        emit(record);
      },
    });
    if (outcome.error) {
      logger.error("Batch URL import failed", {
        batchId: record.id,
        error: outcome.error.message,
      });
    }
    record.status = outcome.status;
    record.finishedAt = new Date().toISOString();
    emit(record);
  })();

  return { batchId: record.id, done };
}

/** Test-only: drop all state so files don't leak imports into each other. */
export function resetUrlImportBatchForTests(): void {
  current = null;
  listeners.clear();
}
