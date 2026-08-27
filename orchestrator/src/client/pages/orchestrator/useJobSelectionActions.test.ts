import {
  startJobActionBatch,
  watchJobActionBatch,
} from "@client/lib/job-action-batches";
import { createJob } from "@shared/testing/factories.js";
import type {
  JobActionBatchSnapshot,
  JobActionResponse,
} from "@shared/types.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useJobSelectionActions } from "./useJobSelectionActions";

vi.mock("@client/api", () => ({
  ApiClientError: class ApiClientError extends Error {},
}));

vi.mock("@client/lib/job-action-batches", () => ({
  startJobActionBatch: vi.fn(),
  watchJobActionBatch: vi.fn(),
  cancelJobActionBatch: vi.fn(),
  subscribeToJobActionBatches: vi.fn(() => () => {}),
  getJobActionBatchSnapshots: vi.fn(() => []),
}));

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    dismiss: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/**
 * The batch API's counters-only view of a finished action. Derived from the
 * old response fixture so the existing expectations still describe the same
 * outcomes.
 */
const asBatchSnapshot = (
  response: JobActionResponse,
  batchId = "batch-1",
  status: JobActionBatchSnapshot["status"] = "completed",
): JobActionBatchSnapshot => {
  const failures = response.results.filter(
    (result): result is Extract<typeof result, { ok: false }> => !result.ok,
  );
  return {
    batchId,
    action: response.action,
    status,
    requested: response.requested,
    completed: response.results.length,
    succeeded: response.succeeded,
    failed: response.failed,
    startedAt: "2026-08-27T00:00:00.000Z",
    finishedAt: "2026-08-27T00:00:01.000Z",
    failedJobIds: failures.map((result) => result.jobId),
    firstFailureMessage: failures[0]?.error.message ?? null,
  };
};

const mockBatch = (
  response: JobActionResponse,
  waitForRelease?: Promise<void>,
  status: JobActionBatchSnapshot["status"] = "completed",
) => {
  vi.mocked(startJobActionBatch).mockResolvedValue("batch-1");
  vi.mocked(watchJobActionBatch).mockImplementation(async () => {
    if (waitForRelease) await waitForRelease;
    return asBatchSnapshot(response, "batch-1", status);
  });
};

describe("useJobSelectionActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(toast.loading).mockReturnValue("job-progress-toast");
  });

  it("caps select-all to the API max", () => {
    const activeJobs = Array.from({ length: 101 }, (_, index) =>
      createJob({ id: `job-${index + 1}`, status: "discovered" }),
    );
    const loadJobs = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useJobSelectionActions({
        activeJobs,
        activeTab: "inbox",
        loadJobs,
        maxBulkActionJobs: 100,
      }),
    );

    act(() => {
      result.current.toggleSelectAll(true);
    });

    expect(result.current.selectedJobIds.size).toBe(100);
  });

  it("does not send action requests above the max selection size", async () => {
    const activeJobs = Array.from({ length: 101 }, (_, index) =>
      createJob({ id: `job-${index + 1}`, status: "discovered" }),
    );
    const loadJobs = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useJobSelectionActions({
        activeJobs,
        activeTab: "inbox",
        loadJobs,
        maxBulkActionJobs: 100,
      }),
    );

    act(() => {
      for (const job of activeJobs) {
        result.current.toggleSelectJob(job.id);
      }
    });

    await act(async () => {
      await result.current.runJobAction("skip");
    });

    expect(startJobActionBatch).not.toHaveBeenCalled();
  });

  // A cancelled batch names the rows that FAILED but not the ones that
  // succeeded, so "which never ran" is unknowable here. The selection is left
  // untouched so the undispatched rows are still there to re-run, and no undo
  // is offered over a set it could only half-restore.
  it("keeps the selection and offers no undo when a batch is stopped", async () => {
    const activeJobs = [
      createJob({ id: "job-1", status: "discovered" }),
      createJob({ id: "job-2", status: "discovered" }),
    ];
    const pushUndo = vi.fn();
    mockBatch(
      {
        action: "skip",
        requested: 2,
        succeeded: 1,
        failed: 0,
        results: [
          {
            jobId: "job-1",
            ok: true,
            job: createJob({ id: "job-1", status: "skipped" }),
          },
        ],
      },
      undefined,
      "cancelled",
    );

    const { result } = renderHook(() =>
      useJobSelectionActions({
        activeJobs,
        activeTab: "inbox",
        loadJobs: vi.fn().mockResolvedValue(undefined),
        maxBulkActionJobs: 100,
        pushUndo,
      }),
    );

    act(() => {
      result.current.toggleSelectJob("job-1");
      result.current.toggleSelectJob("job-2");
    });

    await act(async () => {
      await result.current.runJobAction("skip");
    });

    expect(pushUndo).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
    expect(Array.from(result.current.selectedJobIds).sort()).toEqual([
      "job-1",
      "job-2",
    ]);
  });

  // The POST answers immediately now. If the lock were released there, the bar
  // would re-enable mid-batch and a second press would dispatch the same rows
  // again — and rescore/rescrape/delete have no server-side guard against it.
  it("keeps the action bar locked until the batch itself finishes", async () => {
    const activeJobs = [createJob({ id: "job-1", status: "discovered" })];
    const release = deferred<void>();
    mockBatch(
      {
        action: "skip",
        requested: 1,
        succeeded: 1,
        failed: 0,
        results: [
          {
            jobId: "job-1",
            ok: true,
            job: createJob({ id: "job-1", status: "skipped" }),
          },
        ],
      },
      release.promise,
    );

    const { result } = renderHook(() =>
      useJobSelectionActions({
        activeJobs,
        activeTab: "inbox",
        loadJobs: vi.fn().mockResolvedValue(undefined),
        maxBulkActionJobs: 100,
      }),
    );

    act(() => {
      result.current.toggleSelectJob("job-1");
    });

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.runJobAction("skip");
      // Let the POST resolve; the batch is still going.
      await Promise.resolve();
    });
    await waitFor(() => expect(startJobActionBatch).toHaveBeenCalled());
    expect(result.current.jobActionInFlight).toBe("skip");

    await act(async () => {
      release.resolve();
      await running;
    });
    expect(result.current.jobActionInFlight).toBeNull();
  });

  it("reconciles failures with selection changes made during in-flight action", async () => {
    const activeJobs = [
      createJob({ id: "job-1", status: "discovered" }),
      createJob({ id: "job-2", status: "discovered" }),
      createJob({ id: "job-3", status: "discovered" }),
    ];
    const loadJobs = vi.fn().mockResolvedValue(undefined);
    const release = deferred<void>();
    mockBatch(
      {
        action: "skip",
        requested: 2,
        succeeded: 1,
        failed: 1,
        results: [
          {
            jobId: "job-1",
            ok: true,
            job: createJob({ id: "job-1", status: "skipped" }),
          },
          {
            jobId: "job-2",
            ok: false,
            error: { code: "INVALID_REQUEST", message: "bad status" },
          },
        ],
      },
      release.promise,
    );

    const { result } = renderHook(() =>
      useJobSelectionActions({
        activeJobs,
        activeTab: "inbox",
        loadJobs,
        maxBulkActionJobs: 100,
      }),
    );

    act(() => {
      result.current.toggleSelectJob("job-1");
      result.current.toggleSelectJob("job-2");
    });

    let runPromise: Promise<void>;
    await act(async () => {
      runPromise = result.current.runJobAction("skip");
    });

    expect(toast.loading).toHaveBeenCalled();
    const firstLoadingCall = vi.mocked(toast.loading).mock.calls[0];
    expect(firstLoadingCall[1]).not.toHaveProperty("cancel");

    act(() => {
      result.current.toggleSelectJob("job-2");
      result.current.toggleSelectJob("job-3");
    });

    await act(async () => {
      release.resolve();
      await runPromise;
    });

    await waitFor(() => {
      expect(Array.from(result.current.selectedJobIds)).toEqual(["job-3"]);
    });
    expect(toast.dismiss).toHaveBeenCalled();
  });

  it("sends only the LinkedIn subset of a mixed selection to fetch_live_status", async () => {
    const activeJobs = [
      createJob({
        id: "job-li",
        status: "discovered",
        jobUrl: "https://www.linkedin.com/jobs/view/4441896971",
      }),
      createJob({
        id: "job-other",
        status: "discovered",
        jobUrl: "https://example.com/jobs/123456",
      }),
    ];
    const loadJobs = vi.fn().mockResolvedValue(undefined);
    mockBatch({
      action: "fetch_live_status",
      requested: 1,
      succeeded: 1,
      failed: 0,
      results: [
        {
          jobId: "job-li",
          ok: true,
          job: createJob({ id: "job-li", status: "discovered" }),
        },
      ],
    });

    const { result } = renderHook(() =>
      useJobSelectionActions({
        activeJobs,
        activeTab: "inbox",
        loadJobs,
        maxBulkActionJobs: 100,
      }),
    );

    act(() => {
      result.current.toggleSelectJob("job-li");
      result.current.toggleSelectJob("job-other");
    });

    await act(async () => {
      await result.current.runFetchLiveStatusAction();
    });

    // The non-LinkedIn row is skipped, not sent to fail server-side.
    expect(startJobActionBatch).toHaveBeenCalledWith({
      action: "fetch_live_status",
      jobIds: ["job-li"],
    });
  });

  it("sends the tailored AND failed rows of a mixed selection, never the live one", async () => {
    const activeJobs = [
      createJob({ id: "job-ready", status: "ready" }),
      createJob({ id: "job-running", status: "processing" }),
      createJob({
        id: "job-failed",
        status: "processing",
        tailoringFailureReason: "tectonic exited 1",
      }),
    ];
    const loadJobs = vi.fn().mockResolvedValue(undefined);
    mockBatch({
      action: "retailor",
      requested: 2,
      succeeded: 2,
      failed: 0,
      results: [
        {
          jobId: "job-ready",
          ok: true,
          job: createJob({ id: "job-ready", status: "processing" }),
        },
        {
          jobId: "job-failed",
          ok: true,
          job: createJob({ id: "job-failed", status: "processing" }),
        },
      ],
    });

    const { result } = renderHook(() =>
      useJobSelectionActions({
        activeJobs,
        activeTab: "tailoring",
        loadJobs,
        maxBulkActionJobs: 100,
      }),
    );

    act(() => {
      result.current.toggleSelectJob("job-ready");
      result.current.toggleSelectJob("job-running");
      result.current.toggleSelectJob("job-failed");
    });

    // The count the confirm dialog quotes is the subset, not the selection —
    // a dialog promising 3 jobs' worth of spend while firing 2 is a lie.
    expect(result.current.retailorableCount).toBe(2);
    expect(result.current.canRetailorSelected).toBe(true);

    await act(async () => {
      await result.current.runRetailorAction();
    });

    // The failed row is retried in the same press; the live one is dropped,
    // because a detached tailor is mid-write on it.
    expect(startJobActionBatch).toHaveBeenCalledWith({
      action: "retailor",
      jobIds: ["job-ready", "job-failed"],
    });
  });

  // Pins the OFFER, not the dispatch mechanism: an all-ineligible selection
  // must expose no button and spend nothing. It deliberately claims no more
  // than that — either early return alone would produce it: the dispatcher's
  // own empty check returns first, and runStreamingAction's would too if it
  // were reached, so no assertion here can tell them apart. The subset RULE is
  // pinned by the mixed-selection test above, which
  // is mutation-checked: point the dispatcher at the full selection and that
  // one fails.
  it("dispatches nothing and offers nothing when no selected row is tailored", async () => {
    // A LIVE tailor — the only thing Generate refuses on this tab.
    const activeJobs = [createJob({ id: "job-x", status: "processing" })];
    const loadJobs = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useJobSelectionActions({
        activeJobs,
        activeTab: "tailoring",
        loadJobs,
        maxBulkActionJobs: 100,
      }),
    );

    act(() => {
      result.current.toggleSelectJob("job-x");
    });

    expect(result.current.canRetailorSelected).toBe(false);
    expect(result.current.retailorableCount).toBe(0);

    await act(async () => {
      await result.current.runRetailorAction();
    });

    expect(startJobActionBatch).not.toHaveBeenCalled();
  });

  it("runs rescore and reports success copy", async () => {
    const activeJobs = [
      createJob({ id: "job-1", status: "ready" }),
      createJob({ id: "job-2", status: "ready" }),
    ];
    const loadJobs = vi.fn().mockResolvedValue(undefined);
    mockBatch({
      action: "rescore",
      requested: 2,
      succeeded: 2,
      failed: 0,
      results: [
        {
          jobId: "job-1",
          ok: true,
          job: createJob({ id: "job-1", status: "ready" }),
        },
        {
          jobId: "job-2",
          ok: true,
          job: createJob({ id: "job-2", status: "ready" }),
        },
      ],
    });

    const { result } = renderHook(() =>
      useJobSelectionActions({
        activeJobs,
        activeTab: "tailoring",
        loadJobs,
        maxBulkActionJobs: 100,
      }),
    );

    act(() => {
      result.current.toggleSelectJob("job-1");
      result.current.toggleSelectJob("job-2");
    });

    await act(async () => {
      await result.current.runJobAction("rescore");
    });

    expect(startJobActionBatch).toHaveBeenCalledWith({
      action: "rescore",
      jobIds: ["job-1", "job-2"],
    });
    expect(toast.success).toHaveBeenCalledWith("2 matches recalculated");
  });
});
