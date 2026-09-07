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
import type { ConfirmTailor } from "../orchestrator/tailorCompanyConflicts";
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

import { toast } from "@client/lib/toast";

const job = (overrides: Partial<Job>): Job =>
  createJob({ status: "discovered", ...overrides });

/** Approves everything — what the guard does with the setting off, the default. */
const allowTailor = async (jobs: readonly { id: string }[]) =>
  jobs.map((j) => j.id);

/** The args every pre-existing fixture uses: no terminal event, guard open. */
const baseArgs = { pipelineTerminalEvent: null, confirmTailor: allowTailor };

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

    const { result } = renderHook(() => useSwipeDeck(baseArgs), { wrapper });

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

    const { result } = renderHook(() => useSwipeDeck(baseArgs), { wrapper });

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

    const { result } = renderHook(() => useSwipeDeck(baseArgs), { wrapper });
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

    const { result } = renderHook(() => useSwipeDeck(baseArgs), { wrapper });
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

    const { result } = renderHook(() => useSwipeDeck(baseArgs), { wrapper });

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

    const { result } = renderHook(() => useSwipeDeck(baseArgs), { wrapper });

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

describe("useSwipeDeck duplicate-application guard", () => {
  const twoCards = () => {
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [
        job({ id: "a", employer: "Acme", suitabilityCategory: "great_fit" }),
        job({ id: "b", employer: "Globex", suitabilityCategory: "good_fit" }),
      ],
    } as Awaited<ReturnType<typeof api.getJobs>>);
  };

  const deck = (confirmTailor: ConfirmTailor) =>
    renderHook(
      () => useSwipeDeck({ pipelineTerminalEvent: null, confirmTailor }),
      { wrapper },
    );

  it("asks the guard before a tailor swipe, with the swiped job", async () => {
    twoCards();
    const confirmTailor = vi.fn().mockResolvedValue(["a"]);
    const { result } = deck(confirmTailor);
    await waitFor(() => expect(result.current.cards).toHaveLength(2));

    await act(async () => {
      await result.current.act(result.current.cards[0], "move_to_ready");
    });

    expect(confirmTailor).toHaveBeenCalledTimes(1);
    expect(confirmTailor.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "a", employer: "Acme" }),
    ]);
    expect(startJobActionBatch).toHaveBeenCalledWith({
      action: "move_to_ready",
      jobIds: ["a"],
    });
  });

  it("does not dispatch, and puts the card back, when the guard cancels", async () => {
    twoCards();
    const { result } = deck(vi.fn().mockResolvedValue(null));
    await waitFor(() => expect(result.current.cards).toHaveLength(2));

    await act(async () => {
      await result.current.act(result.current.cards[0], "move_to_ready");
    });

    expect(startJobActionBatch).not.toHaveBeenCalled();
    // Back at the top of the deck, not merely un-hidden somewhere.
    expect(result.current.cards.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("distinguishes a cancel from a failure: same rollback, no error toast", async () => {
    twoCards();
    const { result } = deck(vi.fn().mockResolvedValue(null));
    await waitFor(() => expect(result.current.cards).toHaveLength(2));

    await act(async () => {
      await result.current.act(result.current.cards[0], "move_to_ready");
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(result.current.cards.map((c) => c.id)).toEqual(["a", "b"]);

    // The failure path rolls back the SAME way but does toast — which is the
    // only thing that makes the silence above meaningful.
    vi.mocked(watchJobActionBatch).mockResolvedValue({
      status: "completed",
      failed: 1,
      failedJobIds: ["a"],
    } as unknown as Awaited<ReturnType<typeof watchJobActionBatch>>);
    const approved = deck(vi.fn().mockResolvedValue(["a"]));
    await waitFor(() => expect(approved.result.current.cards).toHaveLength(2));

    await act(async () => {
      await approved.result.current.act(
        approved.result.current.cards[0],
        "move_to_ready",
      );
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("keeps tailor swipes out of undo whether approved or cancelled", async () => {
    // A bare `canUndo === false` after a cancel is satisfied by the initial
    // state — `lastSwipe` is never set for move_to_ready on ANY path. The
    // contrast with `skip`, which DOES set it, is what makes this a real
    // assertion about the code.
    twoCards();
    const { result } = deck(vi.fn().mockResolvedValue(["a"]));
    await waitFor(() => expect(result.current.cards).toHaveLength(2));

    await act(async () => {
      await result.current.act(result.current.cards[0], "move_to_ready");
    });
    expect(result.current.canUndo).toBe(false);

    await act(async () => {
      await result.current.act(result.current.cards[0], "skip");
    });
    expect(result.current.canUndo).toBe(true);

    // And a cancelled tailor adds nothing either — the arm the name claims.
    const cancelled = deck(vi.fn().mockResolvedValue(null));
    await waitFor(() => expect(cancelled.result.current.cards).toHaveLength(2));
    await act(async () => {
      await cancelled.result.current.act(
        cancelled.result.current.cards[0],
        "move_to_ready",
      );
    });
    expect(cancelled.result.current.canUndo).toBe(false);
  });

  it("never asks the guard for skip or backlog", async () => {
    twoCards();
    const confirmTailor = vi.fn().mockResolvedValue(["a"]);
    const { result } = deck(confirmTailor);
    await waitFor(() => expect(result.current.cards).toHaveLength(2));

    await act(async () => {
      await result.current.act(result.current.cards[0], "skip");
    });
    await act(async () => {
      await result.current.act(result.current.cards[0], "move_to_backlog");
    });

    expect(confirmTailor).not.toHaveBeenCalled();
    expect(startJobActionBatch).toHaveBeenCalledTimes(2);
  });
});

describe("useSwipeDeck tailor in-flight lock", () => {
  it("keeps the FIRST swipe parked and bounces a second one back", async () => {
    // Nothing is disabled between the swipe and the dialog appearing, and the
    // card underneath stays draggable. Without the lock the second press
    // reached the guard too, whose newer-press-wins rule resolved the first
    // press null — so the first card silently un-swiped itself and the box
    // that appeared was about the second.
    vi.mocked(api.getJobs).mockResolvedValue({
      jobs: [
        job({ id: "a", employer: "Acme", suitabilityCategory: "great_fit" }),
        job({ id: "b", employer: "Acme", suitabilityCategory: "good_fit" }),
      ],
    } as Awaited<ReturnType<typeof api.getJobs>>);

    let release!: (ids: string[]) => void;
    const confirmTailor = vi.fn(
      (_jobs: readonly { id: string }[]) =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(
      () =>
        useSwipeDeck({
          pipelineTerminalEvent: null,
          confirmTailor,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.cards).toHaveLength(2));

    const [first, second] = result.current.cards;
    await act(async () => {
      void result.current.act(first, "move_to_ready");
      await Promise.resolve();
    });
    expect(result.current.tailorPending).toBe(true);

    await act(async () => {
      await result.current.act(second, "move_to_ready");
    });

    // The guard was asked once, about the FIRST card.
    expect(confirmTailor).toHaveBeenCalledTimes(1);
    expect(confirmTailor.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: "a" }),
    ]);
    // The second card came back; the first is still parked on the answer.
    expect(result.current.cards.map((c) => c.id)).toEqual(["b"]);

    await act(async () => {
      release(["a"]);
    });
    await waitFor(() =>
      expect(startJobActionBatch).toHaveBeenCalledWith({
        action: "move_to_ready",
        jobIds: ["a"],
      }),
    );
    expect(result.current.tailorPending).toBe(false);
  });

  it("does not lock out a skip while a tailor is parked", async () => {
    twoCardsForLock();
    const confirmTailor = vi.fn(() => new Promise<string[]>(() => {}));
    const { result } = renderHook(
      () =>
        useSwipeDeck({
          pipelineTerminalEvent: null,
          confirmTailor,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.cards).toHaveLength(2));

    const [first, second] = result.current.cards;
    await act(async () => {
      void result.current.act(first, "move_to_ready");
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.act(second, "skip");
    });

    expect(startJobActionBatch).toHaveBeenCalledWith({
      action: "skip",
      jobIds: ["b"],
    });
  });
});

function twoCardsForLock() {
  vi.mocked(api.getJobs).mockResolvedValue({
    jobs: [
      job({ id: "a", employer: "Acme", suitabilityCategory: "great_fit" }),
      job({ id: "b", employer: "Globex", suitabilityCategory: "good_fit" }),
    ],
  } as Awaited<ReturnType<typeof api.getJobs>>);
}
