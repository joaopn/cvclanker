import * as api from "@client/api";
import { createJob } from "@shared/testing/factories.js";
import type { JobActionResponse, JobActionStreamEvent } from "@shared/types.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useJobSelectionActions } from "./useJobSelectionActions";

vi.mock("@client/api", () => ({
  streamJobAction: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(),
    dismiss: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
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

const asStreamEvents = (
  response: JobActionResponse,
  requestId = "req-action",
): JobActionStreamEvent[] => {
  const events: JobActionStreamEvent[] = [
    {
      type: "started",
      action: response.action,
      requested: response.requested,
      completed: 0,
      succeeded: 0,
      failed: 0,
      requestId,
    },
  ];

  let succeeded = 0;
  let failed = 0;
  response.results.forEach((result, index) => {
    if (result.ok) succeeded += 1;
    else failed += 1;
    events.push({
      type: "progress",
      action: response.action,
      requested: response.requested,
      completed: index + 1,
      succeeded,
      failed,
      result,
      requestId,
    });
  });

  events.push({
    type: "completed",
    action: response.action,
    requested: response.requested,
    completed: response.requested,
    succeeded: response.succeeded,
    failed: response.failed,
    results: response.results,
    requestId,
  });

  return events;
};

const mockStreamJobAction = (
  response: JobActionResponse,
  waitForRelease?: Promise<void>,
) => {
  vi.mocked(api.streamJobAction).mockImplementation(
    async (_input, handlers) => {
      for (const event of asStreamEvents(response)) {
        if (event.type === "started") handlers.onEvent(event);
      }
      if (waitForRelease) await waitForRelease;
      for (const event of asStreamEvents(response)) {
        if (event.type !== "started") handlers.onEvent(event);
      }
      return;
    },
  );
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

    expect(api.streamJobAction).not.toHaveBeenCalled();
  });

  it("reconciles failures with selection changes made during in-flight action", async () => {
    const activeJobs = [
      createJob({ id: "job-1", status: "discovered" }),
      createJob({ id: "job-2", status: "discovered" }),
      createJob({ id: "job-3", status: "discovered" }),
    ];
    const loadJobs = vi.fn().mockResolvedValue(undefined);
    const release = deferred<void>();
    mockStreamJobAction(
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
    mockStreamJobAction({
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
    expect(api.streamJobAction).toHaveBeenCalledWith(
      { action: "fetch_live_status", jobIds: ["job-li"] },
      expect.objectContaining({
        onEvent: expect.any(Function),
      }),
    );
  });

  it("sends only the ready subset of a mixed selection to retailor", async () => {
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
    mockStreamJobAction({
      action: "retailor",
      requested: 1,
      succeeded: 1,
      failed: 0,
      results: [
        {
          jobId: "job-ready",
          ok: true,
          job: createJob({ id: "job-ready", status: "processing" }),
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
    // a dialog promising 3 jobs' worth of spend while firing 1 is a lie.
    expect(result.current.retailorableCount).toBe(1);
    expect(result.current.canRetailorSelected).toBe(true);

    await act(async () => {
      await result.current.runRetailorAction();
    });

    // The in-flight row would be re-enqueued mid-run and the failed one belongs
    // to Tailor's retry path; neither is sent to fail server-side.
    expect(api.streamJobAction).toHaveBeenCalledWith(
      { action: "retailor", jobIds: ["job-ready"] },
      expect.objectContaining({ onEvent: expect.any(Function) }),
    );
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

    expect(api.streamJobAction).not.toHaveBeenCalled();
  });

  it("runs rescore and reports success copy", async () => {
    const activeJobs = [
      createJob({ id: "job-1", status: "ready" }),
      createJob({ id: "job-2", status: "ready" }),
    ];
    const loadJobs = vi.fn().mockResolvedValue(undefined);
    mockStreamJobAction({
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

    expect(api.streamJobAction).toHaveBeenCalledWith(
      { action: "rescore", jobIds: ["job-1", "job-2"] },
      expect.objectContaining({
        onEvent: expect.any(Function),
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("2 matches recalculated");
  });
});
