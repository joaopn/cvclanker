import * as api from "@client/api";
import {
  startJobActionBatch,
  watchJobActionBatch,
} from "@client/lib/job-action-batches";
import { createJob } from "@shared/testing/factories.js";
import type { Job } from "@shared/types.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSwipeDeck } from "./useSwipeDeck";

vi.mock("@client/api", () => ({
  getJobs: vi.fn(),
  updateJob: vi.fn(),
}));

vi.mock("@client/lib/job-action-batches", () => ({
  startJobActionBatch: vi.fn(),
  watchJobActionBatch: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const job = (overrides: Partial<Job>): Job =>
  createJob({ status: "discovered", ...overrides });

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(startJobActionBatch).mockResolvedValue("batch-1");
  vi.mocked(watchJobActionBatch).mockResolvedValue({
    batchId: "batch-1",
    action: "skip",
    status: "completed",
    requested: 1,
    completed: 1,
    succeeded: 1,
    failed: 0,
    startedAt: "2026-08-27T00:00:00.000Z",
    finishedAt: "2026-08-27T00:00:01.000Z",
    failedJobIds: [],
    firstFailureMessage: null,
  });
  vi.mocked(api.updateJob).mockResolvedValue(
    createJob({ id: "x" }) as Awaited<ReturnType<typeof api.updateJob>>,
  );
});

describe("useSwipeDeck", () => {
  it("orders cards fit-first then newest-posted", async () => {
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [
        job({ id: "bad", suitabilityCategory: "bad_fit", datePosted: null }),
        job({
          id: "good-old",
          suitabilityCategory: "good_fit",
          datePosted: "2026-01-01T00:00:00.000Z",
        }),
        job({
          id: "great",
          suitabilityCategory: "very_good_fit",
          datePosted: "2026-01-01T00:00:00.000Z",
        }),
        job({
          id: "good-new",
          suitabilityCategory: "good_fit",
          datePosted: "2026-06-01T00:00:00.000Z",
        }),
        job({ id: "unscored", suitabilityCategory: null, datePosted: null }),
      ],
    } as Awaited<ReturnType<typeof api.getJobs>>);

    const { result } = renderHook(
      () => useSwipeDeck({ pipelineTerminalEvent: null }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.cards.map((c) => c.id)).toEqual([
      "great",
      "good-new",
      "good-old",
      "bad",
      "unscored",
    ]);
  });

  it("fires the mapped action with a single jobId and removes the card", async () => {
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [
        job({ id: "a", suitabilityCategory: "very_good_fit" }),
        job({ id: "b", suitabilityCategory: "good_fit" }),
      ],
    } as Awaited<ReturnType<typeof api.getJobs>>);

    const { result } = renderHook(
      () => useSwipeDeck({ pipelineTerminalEvent: null }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.cards).toHaveLength(2));

    await act(async () => {
      await result.current.act(result.current.cards[0], "move_to_ready");
    });

    expect(startJobActionBatch).toHaveBeenCalledWith({
      action: "move_to_ready",
      jobIds: ["a"],
    });
    expect(result.current.cards.map((c) => c.id)).toEqual(["b"]);
  });

  // The rollback used to hang off a rejected stream promise. Now the batch
  // resolves normally and the verdict comes from its counters, so this arm has
  // to be exercised on its own.
  it("restores the card when the batch reports the job failed", async () => {
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [job({ id: "a", suitabilityCategory: "good_fit" })],
    } as Awaited<ReturnType<typeof api.getJobs>>);
    vi.mocked(watchJobActionBatch).mockResolvedValue({
      batchId: "batch-1",
      action: "skip",
      status: "completed",
      requested: 1,
      completed: 1,
      succeeded: 0,
      failed: 1,
      startedAt: "2026-08-27T00:00:00.000Z",
      finishedAt: "2026-08-27T00:00:01.000Z",
      failedJobIds: ["a"],
      firstFailureMessage: "nope",
    });

    const { result } = renderHook(
      () => useSwipeDeck({ pipelineTerminalEvent: null }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.cards).toHaveLength(1));

    await act(async () => {
      await result.current.act(result.current.cards[0], "skip");
    });

    expect(result.current.cards.map((c) => c.id)).toEqual(["a"]);
  });

  it("restores the card when the batch never completed", async () => {
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [job({ id: "a", suitabilityCategory: "good_fit" })],
    } as Awaited<ReturnType<typeof api.getJobs>>);
    vi.mocked(watchJobActionBatch).mockResolvedValue({
      batchId: "batch-1",
      action: "skip",
      status: "cancelled",
      requested: 1,
      completed: 0,
      succeeded: 0,
      failed: 0,
      startedAt: "2026-08-27T00:00:00.000Z",
      finishedAt: "2026-08-27T00:00:01.000Z",
      failedJobIds: [],
      firstFailureMessage: null,
    });

    const { result } = renderHook(
      () => useSwipeDeck({ pipelineTerminalEvent: null }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.cards).toHaveLength(1));

    await act(async () => {
      await result.current.act(result.current.cards[0], "skip");
    });

    expect(result.current.cards.map((c) => c.id)).toEqual(["a"]);
  });

  it("restores the card when the action fails", async () => {
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [job({ id: "a", suitabilityCategory: "good_fit" })],
    } as Awaited<ReturnType<typeof api.getJobs>>);
    vi.mocked(startJobActionBatch).mockRejectedValue(new Error("boom"));

    const { result } = renderHook(
      () => useSwipeDeck({ pipelineTerminalEvent: null }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.cards).toHaveLength(1));

    await act(async () => {
      await result.current.act(result.current.cards[0], "skip");
    });

    expect(result.current.cards.map((c) => c.id)).toEqual(["a"]);
  });

  it("undoes the last swipe: PATCHes back to discovered and re-enters the deck", async () => {
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [job({ id: "a", suitabilityCategory: "very_good_fit" })],
    } as Awaited<ReturnType<typeof api.getJobs>>);

    const { result } = renderHook(
      () => useSwipeDeck({ pipelineTerminalEvent: null }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.cards).toHaveLength(1));
    expect(result.current.canUndo).toBe(false);

    await act(async () => {
      await result.current.act(result.current.cards[0], "skip");
    });
    expect(result.current.cards).toHaveLength(0);
    expect(result.current.canUndo).toBe(true);

    await act(async () => {
      await result.current.undo();
    });

    expect(api.updateJob).toHaveBeenCalledWith("a", {
      status: "discovered",
      outcome: null,
      closedAt: null,
    });
    expect(result.current.cards.map((c) => c.id)).toEqual(["a"]);
    expect(result.current.canUndo).toBe(false);
  });
});
