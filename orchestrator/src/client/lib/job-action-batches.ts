/**
 * Client-side view of the server's detached bulk-action batches.
 *
 * Module-level rather than a React hook because two unrelated surfaces watch
 * the same batches — the Manage list's selection bar and the Swipe deck — and
 * a batch outlives the component that started it by design. State here is
 * derived from the server's snapshot on every (re)connect, so it self-heals
 * rather than drifting.
 *
 * The stream is opened LAZILY and closed when nothing is running: on `/jobs`
 * during a pipeline run the app already holds three streams to
 * `/api/pipeline/progress` plus the LLM queue, against a browser cap of about
 * six connections per origin that also has to carry the ordinary jobs poll.
 */

import * as api from "@client/api/client";
import { subscribeToEventSource } from "@client/lib/sse";
import {
  type JobActionBatchSnapshot,
  type JobActionBatchStreamEvent,
  MAX_RETAINED_TERMINAL_BATCHES,
} from "@shared/types";

export class JobActionBatchInterruptedError extends Error {
  constructor() {
    super("The server lost this batch before it finished.");
    this.name = "JobActionBatchInterruptedError";
  }
}

interface Waiter {
  resolve: (batch: JobActionBatchSnapshot) => void;
  reject: (error: Error) => void;
}

const batches = new Map<string, JobActionBatchSnapshot>();
const listeners = new Set<() => void>();
const waiters = new Map<string, Waiter[]>();

/**
 * Batches the server has confirmed exist — seeded either by a frame that
 * listed one or by the POST that created one. Absence from a later frame only
 * means "lost" for a batch that was on this list; anything else is a batch we
 * simply have not been told about yet.
 */
const everSeen = new Set<string>();
/** Batches observed in a terminal state, so a later absence is just eviction. */
const settled = new Set<string>();
/**
 * Batches THIS tab started. The selection bar already shows a progress toast
 * for these, so the attach surface must skip them or every own action shows up
 * twice.
 */
const ownedHere = new Set<string>();

let unsubscribe: (() => void) | null = null;
/** False once the stream errors, until a fresh connection opens. */
let streamHealthy = false;

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the others being told.
    }
  }
}

function settle(batch: JobActionBatchSnapshot) {
  settled.add(batch.batchId);
  const pending = waiters.get(batch.batchId);
  if (!pending) return;
  waiters.delete(batch.batchId);
  for (const waiter of pending) waiter.resolve(batch);
}

function record(batch: JobActionBatchSnapshot) {
  batches.set(batch.batchId, batch);
  everSeen.add(batch.batchId);
  if (batch.status !== "running") {
    settle(batch);
    forgetOldestSettled();
    return;
  }
  // A running batch always has a stream behind it. Cheap to assert here and it
  // is the only thing that recovers a stream closed a frame too early.
  openStream();
}

/**
 * A frame is the COMPLETE set of retained batches, which is the only thing that
 * makes absence meaningful: nothing here is persisted server-side, so a batch
 * that disappears without ever reaching a terminal state died with the process.
 * Its watchers must be told, or a progress toast spins forever and the action
 * bar stays disabled until the page is reloaded.
 *
 * But absence from ONE frame is not proof. A stream snapshot is built when the
 * connection is accepted, and a batch POSTed while that connection was being
 * established is legitimately missing from it — on the Swipe deck, where a
 * second swipe lands during the first one's connect, that is a routine
 * interleaving rather than a corner case. So a suspected loss is CONFIRMED
 * against a fresh read before anyone is failed; that read is issued now, so it
 * cannot predate a batch we already know exists.
 *
 * The discovery poll never concludes anything on its own: it is a plain GET
 * that can be issued before a batch exists and land after it.
 */
function applySnapshot(
  frame: JobActionBatchSnapshot[],
  options: { authoritative: boolean },
) {
  for (const batch of frame) record(batch);
  forgetOldestSettled();
  if (!options.authoritative) return;

  const present = new Set(frame.map((batch) => batch.batchId));
  const suspected = [...everSeen].filter(
    (batchId) => !present.has(batchId) && !settled.has(batchId),
  );
  if (suspected.length > 0) void confirmLosses(suspected);
}

/** Fail the watchers of batches a fresh read agrees are gone. */
async function confirmLosses(suspected: string[]) {
  let frame: JobActionBatchSnapshot[];
  try {
    frame = await api.getJobActionBatches();
  } catch {
    // Could not confirm — leave every watcher alone. The next frame retries,
    // and a spinning toast beats failing an action that actually ran.
    return;
  }
  for (const batch of frame) record(batch);
  const present = new Set(frame.map((batch) => batch.batchId));
  let changed = false;
  for (const batchId of suspected) {
    if (present.has(batchId) || settled.has(batchId)) continue;
    const pending = waiters.get(batchId);
    if (pending) {
      waiters.delete(batchId);
      for (const waiter of pending) {
        waiter.reject(new JobActionBatchInterruptedError());
      }
    }
    everSeen.delete(batchId);
    ownedHere.delete(batchId);
    // Terminal snapshots are kept even once the server evicts them, so a
    // watcher attaching later can still read the outcome; this one never
    // reached a terminal state, so there is nothing to keep.
    batches.delete(batchId);
    changed = true;
  }
  // Always: the read recorded a whole fresh frame, and in the case this exists
  // for — the batch turning out to be alive — nothing else would say so.
  notify();
  if (changed) closeStreamIfIdle();
}

/**
 * Bound the retained terminal snapshots. Mirrors the server's own window: a
 * long session of swipes would otherwise accumulate one entry per action for
 * the life of the page.
 */
function forgetOldestSettled() {
  const finished = [...batches.values()].filter(
    (batch) => batch.status !== "running",
  );
  if (finished.length <= MAX_RETAINED_TERMINAL_BATCHES) return;
  finished
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""))
    .slice(0, finished.length - MAX_RETAINED_TERMINAL_BATCHES)
    .forEach((batch) => {
      if (waiters.has(batch.batchId)) return;
      batches.delete(batch.batchId);
      settled.delete(batch.batchId);
      everSeen.delete(batch.batchId);
      ownedHere.delete(batch.batchId);
    });
}

function openStream() {
  if (unsubscribe && streamHealthy) return;
  // Re-opening over a subscription the helper has abandoned for good (a 401):
  // its loop has returned, so it must be released explicitly before a new one
  // can take over. Transient failures never get here — they stay inside the
  // helper's own backoff.
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  streamHealthy = true;
  unsubscribe = subscribeToEventSource<JobActionBatchStreamEvent>(
    "/api/jobs/actions/batches/stream",
    {
      onOpen: () => {
        streamHealthy = true;
      },
      onError: ({ fatal }) => {
        // A transient failure is the helper's own business: it is already
        // backing off and will replay a snapshot when it reconnects. Tearing
        // down here would abort that backoff and restart it from the floor,
        // turning a broken stream route into a request storm.
        if (!fatal) return;
        // Fatal means a 401, which clears the session and redirects to sign
        // in. Nothing can be recovered now; marking the subscription unhealthy
        // is what lets discovery re-open a live one after signing back in,
        // instead of finding a dead `unsubscribe` and returning early.
        streamHealthy = false;
      },
      onMessage: (event) => {
        if (event.type === "snapshot")
          applySnapshot(event.batches, { authoritative: true });
        else record(event.batch);
        notify();
        // Re-evaluated on every event, not only when a watcher settles: a tab
        // that merely WATCHES another device's batch has no waiter to hang the
        // close off, and would otherwise hold the connection for the life of
        // the page. Deferred a microtask because one read can carry several
        // frames and the reader drains them all before re-checking whether it
        // was closed.
        queueMicrotask(closeStreamIfIdle);
      },
    },
  );
}

/** Close once nothing is running and nobody is waiting, so the idle app holds no extra connection. */
function closeStreamIfIdle() {
  if (!unsubscribe) return;
  if (waiters.size > 0) return;
  for (const batch of batches.values()) {
    if (batch.status === "running") return;
  }
  unsubscribe();
  unsubscribe = null;
}

export function subscribeToJobActionBatches(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getJobActionBatchSnapshots(): JobActionBatchSnapshot[] {
  return [...batches.values()];
}

/** Whether this tab is the one that started the batch. */
export function isOwnJobActionBatch(batchId: string): boolean {
  return ownedHere.has(batchId);
}

/**
 * Discover batches already running — the whole point of the feature: one device
 * starts the work, another picks it up. Opens the stream only if something is
 * actually in flight.
 */
export async function refreshJobActionBatches(): Promise<void> {
  const frame = await api.getJobActionBatches();
  applySnapshot(frame, { authoritative: false });
  notify();
  if (frame.some((batch) => batch.status === "running")) openStream();
  else closeStreamIfIdle();
}

/**
 * Start a batch. The stream is opened by the WATCHER, strictly after this
 * resolves: a stream opened first would replay a snapshot taken before the
 * batch existed, and absence from a frame is exactly how a lost batch is
 * detected. Nothing is missed by waiting — the server retains finished
 * batches, so even one that completes in the gap is still in the snapshot.
 */
export async function startJobActionBatch(
  request: Parameters<typeof api.startJobActionBatch>[0],
): Promise<string> {
  const batchId = await api.startJobActionBatch(request);
  // The server just confirmed it exists, so a later frame without it means it
  // was lost rather than not-yet-announced.
  everSeen.add(batchId);
  ownedHere.add(batchId);
  return batchId;
}

/**
 * Resolve when the batch reaches a terminal state; reject if the server loses
 * it first. Never hangs on a batch the server has already finished and is still
 * retaining.
 */
export function watchJobActionBatch(
  batchId: string,
): Promise<JobActionBatchSnapshot> {
  const known = batches.get(batchId);
  if (known && known.status !== "running") {
    closeStreamIfIdle();
    return Promise.resolve(known);
  }

  openStream();
  return new Promise<JobActionBatchSnapshot>((resolve, reject) => {
    const pending = waiters.get(batchId) ?? [];
    pending.push({ resolve, reject });
    waiters.set(batchId, pending);
  }).finally(() => {
    closeStreamIfIdle();
  });
}

export async function cancelJobActionBatch(batchId: string): Promise<void> {
  await api.cancelJobActionBatch(batchId);
}

/** Test-only: drop every trace so files don't leak batches into each other. */
export function resetJobActionBatchClientForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  streamHealthy = false;
  batches.clear();
  listeners.clear();
  waiters.clear();
  everSeen.clear();
  settled.clear();
  ownedHere.clear();
}
