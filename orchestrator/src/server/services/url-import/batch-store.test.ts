// @vitest-environment node
import type { BatchUrlImportItemResult } from "@shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelUrlImportBatch,
  getUrlImportBatch,
  isUrlImportRunning,
  resetUrlImportBatchForTests,
  startUrlImportBatch,
  subscribeToUrlImportBatch,
} from "./batch-store";

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const created = (url: string): BatchUrlImportItemResult => ({
  ok: true,
  status: "created",
  url,
  jobId: `job-${url}`,
  title: "Engineer",
  employer: "Acme",
});
const duplicate = (url: string): BatchUrlImportItemResult => ({
  ok: true,
  status: "duplicate",
  url,
  jobId: `job-${url}`,
  title: "Engineer",
  employer: "Acme",
});
const failed = (url: string): BatchUrlImportItemResult => ({
  ok: false,
  status: "failed",
  url,
  code: "UPSTREAM_ERROR",
  message: "fetch blocked",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  resetUrlImportBatchForTests();
});

describe("url import batch store", () => {
  it("counts each outcome kind and keeps every result", async () => {
    const started = startUrlImportBatch({
      urls: ["a", "b", "c"],
      concurrency: 3,
      importUrl: async (url) =>
        url === "a" ? created(url) : url === "b" ? duplicate(url) : failed(url),
    });
    await started?.done;

    const batch = getUrlImportBatch();
    expect(batch).toMatchObject({
      status: "completed",
      requested: 3,
      completed: 3,
      succeeded: 1,
      duplicates: 1,
      failed: 1,
    });
    expect(batch?.results).toHaveLength(3);
  });

  // The sheet lists rows in the order the user pasted them; a table that
  // reshuffles as results land is unreadable.
  it("returns results in REQUEST order however they settle", async () => {
    const gates = { a: deferred<void>(), b: deferred<void>() };
    const started = startUrlImportBatch({
      urls: ["a", "b"],
      concurrency: 2,
      importUrl: async (url) => {
        await gates[url as "a" | "b"].promise;
        return created(url);
      },
    });
    gates.b.resolve();
    gates.a.resolve();
    await started?.done;

    expect(getUrlImportBatch()?.results.map((r) => r.url)).toEqual(["a", "b"]);
  });

  // The URL list is load-bearing: a device attaching at 1/3 has one result, and
  // rows built from results alone would show one URL instead of three.
  it("carries the whole requested list from the first moment", async () => {
    const gate = deferred<void>();
    const started = startUrlImportBatch({
      urls: ["a", "b", "c"],
      concurrency: 1,
      importUrl: async (url) => {
        await gate.promise;
        return created(url);
      },
    });

    const live = getUrlImportBatch();
    expect(live?.urls).toEqual(["a", "b", "c"]);
    expect(live?.requested).toBe(3);
    expect(live?.results).toEqual([]);

    gate.resolve();
    await started?.done;
  });

  it("refuses a second import while one runs, and allows one after", async () => {
    const gate = deferred<void>();
    const first = startUrlImportBatch({
      urls: ["a"],
      concurrency: 1,
      importUrl: async (url) => {
        await gate.promise;
        return created(url);
      },
    });
    expect(first).not.toBeNull();
    expect(isUrlImportRunning()).toBe(true);

    expect(
      startUrlImportBatch({
        urls: ["b"],
        concurrency: 1,
        importUrl: async (url) => created(url),
      }),
    ).toBeNull();

    gate.resolve();
    await first?.done;
    expect(isUrlImportRunning()).toBe(false);

    const second = startUrlImportBatch({
      urls: ["b"],
      concurrency: 1,
      importUrl: async (url) => created(url),
    });
    expect(second).not.toBeNull();
    await second?.done;
  });

  it("keeps running after the starter stops waiting", async () => {
    const gate = deferred<void>();
    const started = startUrlImportBatch({
      urls: ["a"],
      concurrency: 1,
      importUrl: async (url) => {
        await gate.promise;
        return created(url);
      },
    });
    expect(isUrlImportRunning()).toBe(true);
    gate.resolve();
    await started?.done;
    expect(getUrlImportBatch()?.status).toBe("completed");
  });

  it("cancel stops dispatch and settles below requested", async () => {
    const gate = deferred<void>();
    let startedCount = 0;
    const started = startUrlImportBatch({
      urls: ["a", "b", "c"],
      concurrency: 1,
      importUrl: async (url) => {
        startedCount += 1;
        await gate.promise;
        return created(url);
      },
    });

    await vi.waitFor(() => expect(startedCount).toBe(1));
    expect(cancelUrlImportBatch()).toBe(true);
    gate.resolve();
    await started?.done;

    const batch = getUrlImportBatch();
    expect(batch?.status).toBe("cancelled");
    expect(batch?.completed).toBe(1);
    expect(batch?.requested).toBe(3);
    expect(cancelUrlImportBatch()).toBe(false);
  });

  it("reaches a terminal state when the pool throws", async () => {
    const started = startUrlImportBatch({
      urls: ["a"],
      concurrency: 1,
      importUrl: async () => {
        throw new Error("import exploded");
      },
    });
    await started?.done;
    expect(getUrlImportBatch()?.status).toBe("failed");
    expect(isUrlImportRunning()).toBe(false);
  });

  it("tells subscribers on start, per settled URL, and at the end", async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToUrlImportBatch((batch) => {
      seen.push(`${batch.status}:${batch.completed}`);
    });
    const started = startUrlImportBatch({
      urls: ["a", "b"],
      concurrency: 1,
      importUrl: async (url) => created(url),
    });
    await started?.done;
    unsubscribe();
    expect(seen).toEqual([
      "running:0",
      "running:1",
      "running:2",
      "completed:2",
    ]);
  });
});
