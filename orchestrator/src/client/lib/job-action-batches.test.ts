import type {
  JobActionBatchSnapshot,
  JobActionBatchStreamEvent,
} from "@shared/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startBatchMock = vi.fn();
const getBatchesMock = vi.fn();
const cancelBatchMock = vi.fn();
const subscribeMock = vi.fn();

vi.mock("@client/api/client", () => ({
  startJobActionBatch: (...args: unknown[]) => startBatchMock(...args),
  getJobActionBatches: (...args: unknown[]) => getBatchesMock(...args),
  cancelJobActionBatch: (...args: unknown[]) => cancelBatchMock(...args),
}));

vi.mock("@client/lib/sse", () => ({
  subscribeToEventSource: (...args: unknown[]) => subscribeMock(...args),
}));

import {
  getJobActionBatchSnapshots,
  isOwnJobActionBatch,
  JobActionBatchInterruptedError,
  refreshJobActionBatches,
  resetJobActionBatchClientForTests,
  startJobActionBatch,
  watchJobActionBatch,
} from "./job-action-batches";

/** Pushes events into whatever handler the module registered with the SSE helper. */
let emit: (event: JobActionBatchStreamEvent) => void;
let unsubscribeSpy: ReturnType<typeof vi.fn>;
let fireOpen: () => void;
let fireError: (info: { fatal: boolean }) => void;

const snapshot = (
  overrides: Partial<JobActionBatchSnapshot> & { batchId: string },
): JobActionBatchSnapshot => ({
  action: "rescore",
  status: "running",
  requested: 2,
  completed: 0,
  succeeded: 0,
  failed: 0,
  startedAt: "2026-08-27T00:00:00.000Z",
  finishedAt: null,
  failedJobIds: [],
  firstFailureMessage: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  unsubscribeSpy = vi.fn();
  subscribeMock.mockImplementation(
    (
      _url: string,
      handlers: {
        onMessage: (e: unknown) => void;
        onOpen?: () => void;
        onError?: (info: { fatal: boolean }) => void;
      },
    ) => {
      emit = handlers.onMessage as typeof emit;
      fireOpen = handlers.onOpen ?? (() => {});
      fireError = handlers.onError ?? (() => {});
      return unsubscribeSpy;
    },
  );
  startBatchMock.mockResolvedValue("batch-1");
  getBatchesMock.mockResolvedValue([]);
});

afterEach(() => {
  resetJobActionBatchClientForTests();
});

describe("job action batch client", () => {
  it("resolves a watcher when its batch reaches a terminal state", async () => {
    const batchId = await startJobActionBatch({
      action: "rescore",
      jobIds: ["a", "b"],
    });
    expect(isOwnJobActionBatch(batchId)).toBe(true);

    const watching = watchJobActionBatch(batchId);
    emit({
      type: "terminal",
      batch: snapshot({
        batchId,
        status: "completed",
        completed: 2,
        succeeded: 2,
      }),
      requestId: "req",
    });

    await expect(watching).resolves.toMatchObject({
      status: "completed",
      succeeded: 2,
    });
  });

  // Nothing is persisted server-side, so a restart takes the registry with it.
  // Without this the progress toast spins forever and the action bar stays
  // disabled until the page is reloaded.
  it("rejects a watcher whose batch disappears without finishing", async () => {
    const batchId = await startJobActionBatch({
      action: "rescore",
      jobIds: ["a"],
    });
    const watching = watchJobActionBatch(batchId);

    emit({
      type: "progress",
      batch: snapshot({ batchId, completed: 1 }),
      lastResult: { jobId: "a", ok: true, errorMessage: null },
      requestId: "req",
    });
    // The server came back empty, and a fresh read agrees — it died with the
    // process rather than being missing from a frame built too early.
    getBatchesMock.mockResolvedValue([]);
    emit({ type: "snapshot", batches: [], requestId: "req" });

    await expect(watching).rejects.toBeInstanceOf(
      JobActionBatchInterruptedError,
    );
  });

  // The discovery poll is a plain GET: it can be issued before a batch exists
  // and land after, so its staleness must never be read as the batch dying.
  it("does not let a stale discovery poll fail a running batch", async () => {
    const batchId = await startJobActionBatch({
      action: "rescore",
      jobIds: ["a"],
    });
    const watching = watchJobActionBatch(batchId);

    getBatchesMock.mockResolvedValue([snapshot({ batchId: "someone-elses" })]);
    await refreshJobActionBatches();

    let settledEarly = false;
    void watching.then(
      () => {
        settledEarly = true;
      },
      () => {
        settledEarly = true;
      },
    );
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    emit({
      type: "terminal",
      batch: snapshot({ batchId, status: "completed", completed: 1 }),
      requestId: "req",
    });
    await expect(watching).resolves.toMatchObject({ status: "completed" });
  });

  // A stream snapshot is built when the connection is accepted, so a batch
  // POSTed while that connection was being established is legitimately absent
  // from it. Failing on one frame would roll back swipes that actually applied.
  it("confirms a suspected loss before failing anyone", async () => {
    const batchId = await startJobActionBatch({
      action: "rescore",
      jobIds: ["a"],
    });
    const watching = watchJobActionBatch(batchId);

    // The frame predates the batch, but a fresh read shows it running.
    getBatchesMock.mockResolvedValue([snapshot({ batchId })]);
    emit({ type: "snapshot", batches: [], requestId: "req" });
    await vi.waitFor(() => expect(getBatchesMock).toHaveBeenCalled());

    let settledEarly = false;
    void watching.then(
      () => {
        settledEarly = true;
      },
      () => {
        settledEarly = true;
      },
    );
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    emit({
      type: "terminal",
      batch: snapshot({ batchId, status: "completed", completed: 1 }),
      requestId: "req",
    });
    await expect(watching).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps every watcher alive when the confirming read fails", async () => {
    const batchId = await startJobActionBatch({
      action: "rescore",
      jobIds: ["a"],
    });
    const watching = watchJobActionBatch(batchId);

    getBatchesMock.mockRejectedValue(new Error("offline"));
    emit({ type: "snapshot", batches: [], requestId: "req" });
    await vi.waitFor(() => expect(getBatchesMock).toHaveBeenCalled());

    let settledEarly = false;
    void watching.then(
      () => {
        settledEarly = true;
      },
      () => {
        settledEarly = true;
      },
    );
    await Promise.resolve();
    // A spinning toast beats failing an action that actually ran.
    expect(settledEarly).toBe(false);
  });

  it("does not reject a batch that finished before it vanished", async () => {
    const batchId = await startJobActionBatch({
      action: "rescore",
      jobIds: ["a"],
    });
    emit({
      type: "terminal",
      batch: snapshot({ batchId, status: "completed", completed: 1 }),
      requestId: "req",
    });
    // Evicted from the retained window; that is not a loss.
    emit({ type: "snapshot", batches: [], requestId: "req" });

    await expect(watchJobActionBatch(batchId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("resolves immediately for a batch already terminal in the snapshot", async () => {
    getBatchesMock.mockResolvedValue([
      snapshot({
        batchId: "batch-old",
        status: "completed",
        completed: 2,
        succeeded: 2,
      }),
    ]);
    await refreshJobActionBatches();

    await expect(watchJobActionBatch("batch-old")).resolves.toMatchObject({
      status: "completed",
    });
    // Nothing is running, so no stream was opened for it.
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  // On /jobs during a run the app already holds three streams to the pipeline
  // progress endpoint plus the LLM queue, against a browser cap of about six
  // per origin that also has to carry the jobs poll.
  it("closes the stream once nothing is running and nobody is waiting", async () => {
    const batchId = await startJobActionBatch({
      action: "rescore",
      jobIds: ["a"],
    });
    const watching = watchJobActionBatch(batchId);
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    emit({
      type: "terminal",
      batch: snapshot({ batchId, status: "completed", completed: 1 }),
      requestId: "req",
    });
    await watching;
    expect(unsubscribeSpy).toHaveBeenCalled();
  });

  it("closes a stream opened by discovery once the remote batch ends", async () => {
    getBatchesMock.mockResolvedValue([snapshot({ batchId: "remote" })]);
    await refreshJobActionBatches();
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    // Nobody on this device is waiting on it, so only the event can close it.
    emit({
      type: "terminal",
      batch: snapshot({
        batchId: "remote",
        status: "completed",
        completed: 2,
      }),
      requestId: "req",
    });
    // Deferred a microtask so a multi-frame chunk finishes draining first.
    await Promise.resolve();
    expect(unsubscribeSpy).toHaveBeenCalled();
  });

  it("opens the stream on discovery only when something is running", async () => {
    getBatchesMock.mockResolvedValue([snapshot({ batchId: "batch-live" })]);
    await refreshJobActionBatches();
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  // One read can carry several frames, and the SSE reader drains them all
  // before re-checking whether it was closed — so a close decided on the first
  // frame still lets the second through. Two things guard that: the close is
  // deferred a microtask, and recording a running batch re-opens. This pins
  // the INVARIANT they jointly protect ("a running batch has a stream"), not
  // either mechanism individually — remove both and it goes red.
  it("keeps a stream for a batch announced in the same chunk as a close", async () => {
    getBatchesMock.mockResolvedValue([snapshot({ batchId: "remote-a" })]);
    await refreshJobActionBatches();
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    emit({
      type: "terminal",
      batch: snapshot({
        batchId: "remote-a",
        status: "completed",
        completed: 2,
      }),
      requestId: "req",
    });
    emit({
      type: "progress",
      batch: snapshot({ batchId: "remote-b" }),
      lastResult: { jobId: "x", ok: true, errorMessage: null },
      requestId: "req",
    });
    await Promise.resolve();

    const live = getJobActionBatchSnapshots().find(
      (batch) => batch.batchId === "remote-b",
    );
    expect(live?.status).toBe("running");
    // A running batch must always have a stream behind it.
    expect(subscribeMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(unsubscribeSpy.mock.calls.length).toBeLessThan(
      subscribeMock.mock.calls.length,
    );
  });

  // The shared SSE helper gives up permanently on a 401 rather than backing
  // off. Without marking the subscription dead, `openStream` would find a
  // non-null `unsubscribe` and return early forever, so nothing would ever
  // reconnect after signing back in.
  it("re-opens the stream after the helper abandons it for good", async () => {
    getBatchesMock.mockResolvedValue([snapshot({ batchId: "remote" })]);
    await refreshJobActionBatches();
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    fireOpen();

    fireError({ fatal: true });
    await refreshJobActionBatches();

    expect(unsubscribeSpy).toHaveBeenCalled();
    expect(subscribeMock).toHaveBeenCalledTimes(2);
  });

  // Every other failure is the helper's own business: it is already backing
  // off and will replay a snapshot on reconnect. Tearing down here would abort
  // that backoff and restart it from the floor — a broken stream route would
  // become a request storm.
  it("leaves a transient stream failure to the helper's backoff", async () => {
    getBatchesMock.mockResolvedValue([snapshot({ batchId: "remote" })]);
    await refreshJobActionBatches();
    fireOpen();

    fireError({ fatal: false });
    await refreshJobActionBatches();

    expect(unsubscribeSpy).not.toHaveBeenCalled();
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat another tab's batch as its own", async () => {
    getBatchesMock.mockResolvedValue([snapshot({ batchId: "batch-remote" })]);
    await refreshJobActionBatches();
    expect(isOwnJobActionBatch("batch-remote")).toBe(false);
  });
});
