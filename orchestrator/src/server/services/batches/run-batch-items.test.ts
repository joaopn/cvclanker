// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runBatchItems } from "./run-batch-items";

describe("runBatchItems", () => {
  it("reports completion when every item settles", async () => {
    const seen: number[] = [];
    const outcome = await runBatchItems({
      items: [1, 2, 3],
      concurrency: 1,
      isCancelled: () => false,
      runItem: async (item) => {
        seen.push(item);
      },
    });
    expect(outcome).toEqual({ status: "completed", error: null });
    expect(seen).toEqual([1, 2, 3]);
  });

  // The whole reason this helper exists: a batch that never reaches a terminal
  // state hangs every watcher of it, and a store that evicts only terminal
  // records can never reclaim it either.
  it("turns a throwing item into a terminal answer rather than propagating", async () => {
    const outcome = await runBatchItems({
      items: ["a"],
      concurrency: 1,
      isCancelled: () => false,
      runItem: async () => {
        throw new Error("item exploded");
      },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("item exploded");
  });

  it("normalises a non-Error throw", async () => {
    const outcome = await runBatchItems({
      items: ["a"],
      concurrency: 1,
      isCancelled: () => false,
      runItem: async () => {
        throw "just a string";
      },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBeInstanceOf(Error);
  });

  // Read AFTER the pool resolves, never during: a cancel arriving while the
  // last items are in flight must not be reported before their rows are written.
  it("reads the cancel flag after the pool has drained", async () => {
    let cancelled = false;
    const settled: string[] = [];
    const outcome = await runBatchItems({
      items: ["a", "b", "c"],
      concurrency: 1,
      isCancelled: () => cancelled,
      runItem: async (item) => {
        if (item === "a") cancelled = true;
        settled.push(item);
      },
    });
    expect(outcome.status).toBe("cancelled");
    // Dispatch stopped between items; the one in flight still finished.
    expect(settled).toEqual(["a"]);
  });

  it("is a no-op that still answers for an empty batch", async () => {
    const runItem = vi.fn();
    const outcome = await runBatchItems({
      items: [],
      concurrency: 4,
      isCancelled: () => false,
      runItem,
    });
    expect(outcome).toEqual({ status: "completed", error: null });
    expect(runItem).not.toHaveBeenCalled();
  });
});
