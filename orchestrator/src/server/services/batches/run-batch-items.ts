/**
 * The one place a detached batch decides how it ended.
 *
 * Everything else about a batch — counters, per-item results, retention,
 * claims — belongs to whichever store owns it. What is shared, and what is
 * dangerous to write twice, is the guarantee that a batch reaches EXACTLY ONE
 * terminal state. A batch stuck at `running` hangs every watcher of it and, in
 * a store that evicts only terminal records, can never be reclaimed either.
 *
 * The decision is RETURNED rather than written through an injected callback,
 * so the caller keeps its own `finish` and calls it once with this answer —
 * "exactly once" then falls out of the shape instead of relying on a helper
 * being disciplined about `finally`.
 */

import { asyncPool } from "@server/utils/async-pool";

export interface BatchItemsOutcome {
  status: "completed" | "cancelled" | "failed";
  error: Error | null;
}

export async function runBatchItems<TItem>(input: {
  items: readonly TItem[];
  concurrency: number;
  /**
   * Read between dispatches, never mid-item: work already awaiting a provider
   * runs to completion, and the answer below is only taken once the pool has
   * fully resolved — so a watcher never sees a terminal event while rows are
   * still being written.
   */
  isCancelled: () => boolean;
  runItem: (item: TItem) => Promise<void>;
}): Promise<BatchItemsOutcome> {
  try {
    await asyncPool<TItem, void>({
      items: input.items,
      concurrency: input.concurrency,
      shouldStop: input.isCancelled,
      task: input.runItem,
    });
    return {
      status: input.isCancelled() ? "cancelled" : "completed",
      error: null,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
