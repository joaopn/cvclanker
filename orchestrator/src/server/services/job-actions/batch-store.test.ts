// @vitest-environment node
import type { Job, JobActionResult } from "@shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelJobActionBatch,
  getClaimedJobIds,
  getJobActionBatches,
  hasRunningJobActionBatches,
  MAX_RETAINED_TERMINAL_BATCHES,
  resetJobActionBatchesForTests,
  startJobActionBatch,
  subscribeToJobActionBatches,
} from "./batch-store";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const okResult = (jobId: string): JobActionResult => ({
  jobId,
  ok: true,
  job: { id: jobId } as Job,
});

const failResult = (jobId: string, message: string): JobActionResult => ({
  jobId,
  ok: false,
  error: { code: "INTERNAL_ERROR", message },
});

/** A promise plus the handles to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  resetJobActionBatchesForTests();
});

describe("job action batch store", () => {
  it("runs detached and reports counters without retaining job rows", async () => {
    const { batchId, done } = startJobActionBatch({
      action: "rescore",
      jobIds: ["a", "b"],
      concurrency: 2,
      retainResults: true,
      runJob: async (jobId) =>
        jobId === "b" ? failResult("b", "boom") : okResult("a"),
    });

    const outcome = await done;
    expect(outcome.status).toBe("completed");
    expect(outcome.results).toHaveLength(2);

    const [snapshot] = getJobActionBatches();
    expect(snapshot.batchId).toBe(batchId);
    expect(snapshot).toMatchObject({
      status: "completed",
      requested: 2,
      completed: 2,
      succeeded: 1,
      failed: 1,
      failedJobIds: ["b"],
      firstFailureMessage: "boom",
    });
    // Counters-only: nothing on the snapshot carries a Job row.
    expect(JSON.stringify(snapshot)).not.toContain('"job"');
  });

  it("returns results in REQUEST order even when the pool settles out of order", async () => {
    const gates = {
      a: deferred<void>(),
      b: deferred<void>(),
      c: deferred<void>(),
    };
    const { done } = startJobActionBatch({
      action: "rescore",
      jobIds: ["a", "b", "c"],
      concurrency: 3,
      retainResults: true,
      runJob: async (jobId) => {
        await gates[jobId as keyof typeof gates].promise;
        return okResult(jobId);
      },
    });

    // Settle back-to-front; the response must not follow.
    gates.c.resolve();
    gates.b.resolve();
    gates.a.resolve();

    const outcome = await done;
    expect(outcome.results.map((result) => result.jobId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps a contested job in its requested position, not at the head", async () => {
    const gate = deferred<void>();
    const holder = startJobActionBatch({
      action: "rescore",
      jobIds: ["b"],
      concurrency: 1,
      runJob: async (jobId) => {
        await gate.promise;
        return okResult(jobId);
      },
    });

    // "b" is refused synchronously at start, before the pool runs "a" and "c".
    const { done } = startJobActionBatch({
      action: "rescore",
      jobIds: ["a", "b", "c"],
      concurrency: 1,
      retainResults: true,
      runJob: async (jobId) => okResult(jobId),
    });
    const outcome = await done;
    expect(outcome.results.map((result) => result.jobId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(outcome.results[1].ok).toBe(false);

    gate.resolve();
    await holder.done;
  });

  it("drops undispatched jobs from the results rather than leaving holes", async () => {
    const gate = deferred<void>();
    let started = 0;
    const { batchId, done } = startJobActionBatch({
      action: "rescore",
      jobIds: ["a", "b", "c"],
      concurrency: 1,
      retainResults: true,
      runJob: async (jobId) => {
        started += 1;
        await gate.promise;
        return okResult(jobId);
      },
    });

    await vi.waitFor(() => expect(started).toBe(1));
    cancelJobActionBatch(batchId);
    gate.resolve();

    const outcome = await done;
    expect(outcome.results.map((result) => result.jobId)).toEqual(["a"]);
  });

  it("keeps the batch running after the starter stops listening", async () => {
    const gate = deferred<void>();
    const { done } = startJobActionBatch({
      action: "rescore",
      jobIds: ["a"],
      concurrency: 1,
      runJob: async (jobId) => {
        await gate.promise;
        return okResult(jobId);
      },
    });

    expect(hasRunningJobActionBatches()).toBe(true);
    gate.resolve();
    await done;
    expect(hasRunningJobActionBatches()).toBe(false);
  });

  it("reaches a terminal state when the pool throws, so watchers cannot hang", async () => {
    const { done } = startJobActionBatch({
      action: "rescore",
      jobIds: ["a"],
      concurrency: 1,
      runJob: async () => {
        throw new Error("pool exploded");
      },
    });

    const outcome = await done;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toBe("pool exploded");

    const [snapshot] = getJobActionBatches();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.finishedAt).not.toBeNull();
    expect(hasRunningJobActionBatches()).toBe(false);
  });

  it("emits a terminal update to subscribers exactly once", async () => {
    const updates: string[] = [];
    const unsubscribe = subscribeToJobActionBatches((update) => {
      updates.push(update.lastResult ? "progress" : "terminal");
    });

    const { done } = startJobActionBatch({
      action: "skip",
      jobIds: ["a", "b"],
      concurrency: 1,
      runJob: async (jobId) => okResult(jobId),
    });
    await done;
    unsubscribe();

    expect(updates).toEqual(["progress", "progress", "terminal"]);
  });

  it("cancel stops dispatch but lets in-flight work finish, settling below requested", async () => {
    const gate = deferred<void>();
    let started = 0;
    const { batchId, done } = startJobActionBatch({
      action: "rescore",
      jobIds: ["a", "b", "c"],
      concurrency: 1,
      runJob: async (jobId) => {
        started += 1;
        await gate.promise;
        return okResult(jobId);
      },
    });

    // The first task is in flight; cancel, then let it complete.
    await vi.waitFor(() => expect(started).toBe(1));
    expect(cancelJobActionBatch(batchId)).toBe(true);
    gate.resolve();

    const outcome = await done;
    expect(outcome.status).toBe("cancelled");
    // The in-flight task ran to completion; the undispatched two were dropped.
    expect(started).toBe(1);
    const [snapshot] = getJobActionBatches();
    expect(snapshot.completed).toBe(1);
    expect(snapshot.requested).toBe(3);
  });

  it("cancel refuses a batch that already finished", async () => {
    const { batchId, done } = startJobActionBatch({
      action: "skip",
      jobIds: ["a"],
      concurrency: 1,
      runJob: async (jobId) => okResult(jobId),
    });
    await done;
    expect(cancelJobActionBatch(batchId)).toBe(false);
    expect(cancelJobActionBatch("no-such-batch")).toBe(false);
  });

  it("refuses a job another running batch already claims, without failing the batch", async () => {
    const gate = deferred<void>();
    const first = startJobActionBatch({
      action: "rescore",
      jobIds: ["shared"],
      concurrency: 1,
      runJob: async (jobId) => {
        await gate.promise;
        return okResult(jobId);
      },
    });

    expect(getClaimedJobIds()).toEqual(new Set(["shared"]));

    const ran: string[] = [];
    const second = startJobActionBatch({
      action: "rescore",
      jobIds: ["shared", "fresh"],
      concurrency: 1,
      retainResults: true,
      runJob: async (jobId) => {
        ran.push(jobId);
        return okResult(jobId);
      },
    });

    const secondOutcome = await second.done;
    expect(ran).toEqual(["fresh"]);
    expect(secondOutcome.status).toBe("completed");
    const contested = secondOutcome.results.find((r) => r.jobId === "shared");
    expect(contested?.ok).toBe(false);

    gate.resolve();
    await first.done;
    // A finished batch holds no claim.
    expect(getClaimedJobIds().size).toBe(0);
  });

  it("dedupes job ids so the counters cannot disagree with the results", async () => {
    let attempt = 0;
    const { done } = startJobActionBatch({
      action: "rescore",
      jobIds: ["a", "a", "b"],
      concurrency: 1,
      retainResults: true,
      runJob: async (jobId) => {
        attempt += 1;
        return attempt === 1 ? failResult(jobId, "first") : okResult(jobId);
      },
    });

    const outcome = await done;
    const [snapshot] = getJobActionBatches();
    expect(snapshot.requested).toBe(2);
    expect(snapshot.completed).toBe(2);
    expect(outcome.results.map((result) => result.jobId)).toEqual(["a", "b"]);
    // The registry's failure count and the returned results agree.
    expect(snapshot.failed).toBe(
      outcome.results.filter((result) => !result.ok).length,
    );
  });

  it("refuses to cancel a batch whose caller answers with the full results", async () => {
    const gate = deferred<void>();
    const { batchId, done } = startJobActionBatch({
      action: "rescore",
      jobIds: ["a"],
      concurrency: 1,
      retainResults: true,
      cancellable: false,
      runJob: async (jobId) => {
        await gate.promise;
        return okResult(jobId);
      },
    });

    expect(cancelJobActionBatch(batchId)).toBe(false);
    gate.resolve();
    const outcome = await done;
    expect(outcome.status).toBe("completed");
    expect(outcome.results).toHaveLength(1);
  });

  it("evicts only finished batches, never a running one", async () => {
    const gate = deferred<void>();
    const live = startJobActionBatch({
      action: "rescore",
      jobIds: ["live"],
      concurrency: 1,
      runJob: async (jobId) => {
        await gate.promise;
        return okResult(jobId);
      },
    });

    for (let i = 0; i < MAX_RETAINED_TERMINAL_BATCHES + 5; i += 1) {
      await startJobActionBatch({
        action: "skip",
        jobIds: [`job-${i}`],
        concurrency: 1,
        runJob: async (jobId) => okResult(jobId),
      }).done;
    }

    const snapshots = getJobActionBatches();
    const finished = snapshots.filter((b) => b.status !== "running");
    expect(finished).toHaveLength(MAX_RETAINED_TERMINAL_BATCHES);
    // The running one survived the flood — evicting it would drop its terminal
    // event and hang every watcher.
    expect(snapshots.some((b) => b.batchId === live.batchId)).toBe(true);

    gate.resolve();
    await live.done;
  });

  it("lists every retained batch, so absence is meaningful to a client", async () => {
    const a = startJobActionBatch({
      action: "skip",
      jobIds: ["a"],
      concurrency: 1,
      runJob: async (jobId) => okResult(jobId),
    });
    const b = startJobActionBatch({
      action: "rescore",
      jobIds: ["b"],
      concurrency: 1,
      runJob: async (jobId) => okResult(jobId),
    });
    await Promise.all([a.done, b.done]);

    const ids = getJobActionBatches().map((batch) => batch.batchId);
    expect(ids).toEqual([a.batchId, b.batchId]);
  });
});
