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
  ManualJobDraft,
  UrlImportBatchSnapshot,
} from "@shared/types";

type Listener = (batch: UrlImportBatchSnapshot) => void;

interface BatchRecord {
  id: string;
  status: JobActionBatchStatus;
  urls: string[];
  /** Keyed by url so the snapshot can be rebuilt in REQUEST order. */
  resultsByUrl: Map<string, BatchUrlImportItemResult>;
  /**
   * What the fetch read for a URL that failed, to pre-fill the manual form.
   * Kept beside the results rather than in them: the snapshot is sent whole on
   * every settled URL, and descriptions run to tens of KB each.
   */
  draftsByUrl: Map<string, ManualJobDraft>;
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

export interface UrlImportOutcome {
  result: BatchUrlImportItemResult;
  /** Partial fields read off a page that failed; kept only for failures. */
  draft?: ManualJobDraft | null;
}

export interface StartUrlImportInput {
  urls: string[];
  concurrency: number;
  importUrl: (url: string) => Promise<UrlImportOutcome>;
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
    draftsByUrl: new Map(),
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
        const { result, draft } = await input.importUrl(url);
        record.resultsByUrl.set(url, result);
        if (!result.ok && draft) record.draftsByUrl.set(url, draft);
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

/**
 * The draft kept for a failed URL of the retained import, or null — also when
 * the import named is no longer the retained one.
 */
export function getUrlImportDraft(
  batchId: string,
  url: string,
): ManualJobDraft | null {
  if (!current || current.id !== batchId) return null;
  return current.draftsByUrl.get(url) ?? null;
}

/**
 * A failed row finished by hand. Replaces that row's result and moves the
 * counters — only when the import is still the retained one AND the row is
 * still failed, so a second save of the same row (a double click, another
 * device) cannot count it twice. The fetch's token usage stays on the row.
 */
export function resolveUrlImportItem(
  batchId: string,
  url: string,
  result: Extract<BatchUrlImportItemResult, { ok: true }>,
): boolean {
  if (!current || current.id !== batchId) return false;
  const previous = current.resultsByUrl.get(url);
  if (!previous || previous.ok) return false;
  current.resultsByUrl.set(url, { ...result, usage: previous.usage ?? null });
  current.draftsByUrl.delete(url);
  current.failed -= 1;
  if (result.status === "created") current.succeeded += 1;
  else current.duplicates += 1;
  emit(current);
  return true;
}

/** Test-only: drop all state so files don't leak imports into each other. */
export function resetUrlImportBatchForTests(): void {
  current = null;
  listeners.clear();
}
