/**
 * Client's view of the one detached URL import.
 *
 * Singleton, mirroring the server: there is at most one import, so this holds a
 * record rather than a registry. Module-level rather than component state
 * because the import outlives the sheet that started it — closing the sheet, or
 * the whole browser, does not stop it.
 */

import * as api from "@client/api/client";
import { createLazyEventStream } from "@client/lib/batch-stream";
import type {
  UrlImportBatchSnapshot,
  UrlImportBatchStreamEvent,
} from "@shared/types";

let current: UrlImportBatchSnapshot | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the others being told.
    }
  }
}

const stream = createLazyEventStream<UrlImportBatchStreamEvent>({
  url: "/api/manual-jobs/import-batch/stream",
  isIdle: () => current?.status !== "running",
  onEvent: (event) => {
    // `snapshot` may carry null (no import retained); `update` never does.
    current = event.batch;
    notify();
  },
});

export function subscribeToUrlImportBatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUrlImportBatch(): UrlImportBatchSnapshot | null {
  return current;
}

/**
 * Discover an import already running — the point of the feature: start it on
 * one device, pick it up on another. Opens the viewer only if one is live.
 */
export async function refreshUrlImportBatch(): Promise<void> {
  const fetched = await api.getUrlImportBatch();
  // A GET issued before a stream frame can land after it. Taking it blindly
  // would regress a terminal record back to `running`, and re-arm the sheet's
  // completion path so it fires a second time.
  const stale =
    fetched !== null &&
    current !== null &&
    fetched.batchId === current.batchId &&
    fetched.completed < current.completed;
  if (!stale) {
    current = fetched;
    notify();
  }
  if (current?.status === "running") stream.ensureOpen();
  else stream.closeIfIdle();
}

/**
 * Start an import and begin watching it. The viewer is opened AFTER the POST
 * resolves: a stream opened first would replay a snapshot taken before this
 * import existed, and the id it carried would not be the one just started.
 */
export async function startUrlImportBatch(urls: string[]): Promise<string> {
  const batchId = await api.startUrlImportBatch(urls);
  stream.ensureOpen();
  return batchId;
}

export async function cancelUrlImportBatch(): Promise<void> {
  await api.cancelUrlImportBatch();
}

/** Test-only: drop every trace so files don't leak imports into each other. */
export function resetUrlImportBatchClientForTests(): void {
  stream.reset();
  current = null;
  listeners.clear();
}
