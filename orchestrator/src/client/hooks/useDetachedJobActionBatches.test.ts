import type { JobActionBatchSnapshot } from "@shared/types.js";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
const subscribeMock = vi.fn();
const snapshotsMock = vi.fn();
const isOwnMock = vi.fn();

vi.mock("@client/lib/job-action-batches", () => ({
  refreshJobActionBatches: (...a: unknown[]) => refreshMock(...a),
  subscribeToJobActionBatches: (...a: unknown[]) => subscribeMock(...a),
  getJobActionBatchSnapshots: (...a: unknown[]) => snapshotsMock(...a),
  isOwnJobActionBatch: (...a: unknown[]) => isOwnMock(...a),
}));

vi.mock("@client/lib/toast", () => ({
  toast: {
    loading: vi.fn(() => "toast-1"),
    dismiss: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { toast } from "@client/lib/toast";
import { useDetachedJobActionBatches } from "./useDetachedJobActionBatches";

let sync: () => void;

const snapshot = (
  overrides: Partial<JobActionBatchSnapshot> & { batchId: string },
): JobActionBatchSnapshot => ({
  action: "rescore",
  status: "running",
  requested: 3,
  completed: 1,
  succeeded: 1,
  failed: 0,
  startedAt: "2026-08-27T00:00:00.000Z",
  finishedAt: null,
  failedJobIds: [],
  firstFailureMessage: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  refreshMock.mockResolvedValue(undefined);
  isOwnMock.mockReturnValue(false);
  snapshotsMock.mockReturnValue([]);
  subscribeMock.mockImplementation((listener: () => void) => {
    sync = listener;
    return vi.fn();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useDetachedJobActionBatches", () => {
  it("discovers batches already running when the page loads", async () => {
    renderHook(() => useDetachedJobActionBatches());
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it("shows progress for a batch another device started", () => {
    renderHook(() => useDetachedJobActionBatches());
    snapshotsMock.mockReturnValue([snapshot({ batchId: "remote" })]);
    sync();
    expect(toast.loading).toHaveBeenCalledWith(
      "1/3 · started elsewhere",
      expect.objectContaining({ duration: Number.POSITIVE_INFINITY }),
    );
  });

  // The selection bar already renders its own progress toast for these.
  it("stays silent about batches this tab started", () => {
    isOwnMock.mockReturnValue(true);
    renderHook(() => useDetachedJobActionBatches());
    snapshotsMock.mockReturnValue([snapshot({ batchId: "mine" })]);
    sync();
    expect(toast.loading).not.toHaveBeenCalled();
  });

  // The server retains the last fifty finished batches, so surfacing a
  // terminal batch this tab never watched would pop fifty summaries on every
  // page load and again on every reconnect.
  it("says nothing about work that had already finished when it first looked", () => {
    renderHook(() => useDetachedJobActionBatches());
    snapshotsMock.mockReturnValue([
      snapshot({
        batchId: "ancient",
        status: "completed",
        completed: 3,
        succeeded: 3,
        finishedAt: "2026-08-27T00:00:05.000Z",
      }),
    ]);
    sync();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.loading).not.toHaveBeenCalled();
  });

  // The toast is rendered with an infinite duration and nothing else clears
  // it, so a batch that dies with the server would otherwise leave a spinner
  // for work that is not happening.
  it("clears the spinner when a batch it was watching disappears", () => {
    renderHook(() => useDetachedJobActionBatches());
    snapshotsMock.mockReturnValue([snapshot({ batchId: "remote" })]);
    sync();
    expect(toast.loading).toHaveBeenCalledTimes(1);

    snapshotsMock.mockReturnValue([]);
    sync();
    expect(toast.dismiss).toHaveBeenCalledWith("toast-1");
    expect(toast.warning).toHaveBeenCalled();
  });

  it("reports the outcome of a batch it watched finish", () => {
    renderHook(() => useDetachedJobActionBatches());
    snapshotsMock.mockReturnValue([snapshot({ batchId: "remote" })]);
    sync();
    snapshotsMock.mockReturnValue([
      snapshot({
        batchId: "remote",
        status: "completed",
        completed: 3,
        succeeded: 3,
        finishedAt: "2026-08-27T00:00:05.000Z",
      }),
    ]);
    sync();
    expect(toast.dismiss).toHaveBeenCalledWith("toast-1");
    expect(toast.success).toHaveBeenCalledWith("3 of 3 done");
  });
});
