import { afterEach, describe, expect, it, vi } from "vitest";
import { ApifyApiError, runApifyActor } from "./client";

type FetchCall = { url: URL; method: string; body?: unknown };

const calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function runData(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: "run-1",
      status: "RUNNING",
      defaultDatasetId: "ds-1",
      options: { timeoutSecs: 3600 },
      ...overrides,
    },
  };
}

/**
 * Routes fetch by URL: start POST, run polls (one response per poll, in
 * order), dataset pages (one response per page, in order), abort POST.
 */
function stubApify(args: {
  polls: Array<Response>;
  pages?: Array<unknown[]>;
  start?: Response;
}) {
  const pages = args.pages ?? [[{ row: 1 }]];
  let pollIndex = 0;
  let pageIndex = 0;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname.endsWith("/runs")) {
        return args.start ?? jsonResponse(runData());
      }
      if (url.pathname.endsWith("/abort")) {
        return jsonResponse(runData({ status: "ABORTING" }));
      }
      if (url.pathname.includes("/actor-runs/")) {
        const next = args.polls[pollIndex];
        pollIndex = Math.min(pollIndex + 1, args.polls.length - 1);
        return next;
      }
      if (url.pathname.includes("/datasets/")) {
        const page = pages[pageIndex] ?? [];
        pageIndex += 1;
        return jsonResponse(page);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const baseArgs = {
  token: "tok",
  actorRef: "acme/actor",
  input: { hello: "world" },
};

describe("runApifyActor (async run + poll)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    calls.length = 0;
  });

  it("starts the run, polls to SUCCEEDED, and returns the dataset", async () => {
    stubApify({
      polls: [
        jsonResponse(runData()),
        jsonResponse(runData({ status: "SUCCEEDED" })),
      ],
      pages: [[{ a: 1 }, { a: 2 }]],
    });

    const outcome = await runApifyActor(baseArgs);

    expect(outcome).toEqual({
      items: [{ a: 1 }, { a: 2 }],
      status: "SUCCEEDED",
    });
    const start = calls[0];
    expect(start.method).toBe("POST");
    expect(start.url.pathname).toBe("/v2/acts/acme~actor/runs");
    expect(start.body).toEqual({ hello: "world" });
    // No run-timeout override: the actor's own configured timeout governs.
    // The hardcoded 290s cap was B42.
    expect(start.url.searchParams.has("timeout")).toBe(false);
    const poll = calls[1];
    expect(poll.url.pathname).toBe("/v2/actor-runs/run-1");
    expect(poll.url.searchParams.get("waitForFinish")).toBe("60");
  });

  it("pages through the dataset until a short page", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ i }));
    stubApify({
      polls: [jsonResponse(runData({ status: "SUCCEEDED" }))],
      pages: [full, [{ i: 1000 }]],
    });

    const outcome = await runApifyActor(baseArgs);

    expect(outcome.items).toHaveLength(1001);
    const datasetCalls = calls.filter((c) =>
      c.url.pathname.includes("/datasets/"),
    );
    expect(datasetCalls).toHaveLength(2);
    expect(datasetCalls[1].url.searchParams.get("offset")).toBe("1000");
  });

  it("returns the rows a TIMED-OUT run had already scraped", async () => {
    stubApify({
      polls: [jsonResponse(runData({ status: "TIMED-OUT" }))],
      pages: [[{ salvaged: true }]],
    });

    const outcome = await runApifyActor(baseArgs);

    expect(outcome.status).toBe("TIMED-OUT");
    expect(outcome.items).toEqual([{ salvaged: true }]);
  });

  it("aborts the run and salvages the dataset when cancelled", async () => {
    stubApify({
      polls: [jsonResponse(runData())],
      pages: [[{ partial: true }]],
    });
    let pollCount = 0;
    const shouldCancel = vi.fn(() => {
      pollCount += 1;
      return pollCount > 1;
    });

    const outcome = await runApifyActor({ ...baseArgs, shouldCancel });

    expect(outcome).toEqual({ items: [{ partial: true }], status: "ABORTED" });
    expect(
      calls.some(
        (c) => c.method === "POST" && c.url.pathname.endsWith("/abort"),
      ),
    ).toBe(true);
  });

  it("throws the actor's own message when the run FAILED", async () => {
    stubApify({
      polls: [
        jsonResponse(
          runData({ status: "FAILED", statusMessage: "boom exploded" }),
        ),
      ],
    });

    await expect(runApifyActor(baseArgs)).rejects.toThrow(
      "Actor run failed: boom exploded",
    );
  });

  it("keeps polling over a transient server error", async () => {
    vi.useFakeTimers();
    try {
      stubApify({
        polls: [
          jsonResponse({ error: "flaky" }, 502),
          jsonResponse(runData({ status: "SUCCEEDED" })),
        ],
        pages: [[{ a: 1 }]],
      });

      const promise = runApifyActor(baseArgs);
      await vi.advanceTimersByTimeAsync(6_000);
      const outcome = await promise;

      expect(outcome.status).toBe("SUCCEEDED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a rate-limited poll instead of forfeiting the run", async () => {
    vi.useFakeTimers();
    try {
      stubApify({
        polls: [
          jsonResponse({ error: "rate limited" }, 429),
          jsonResponse(runData({ status: "SUCCEEDED" })),
        ],
        pages: [[{ a: 1 }]],
      });

      const promise = runApifyActor(baseArgs);
      await vi.advanceTimersByTimeAsync(6_000);
      const outcome = await promise;

      expect(outcome.status).toBe("SUCCEEDED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a rate-limited dataset page rather than losing the salvage", async () => {
    vi.useFakeTimers();
    try {
      const flaky = { current: true };
      const fetchMock = stubApify({
        polls: [jsonResponse(runData({ status: "TIMED-OUT" }))],
        pages: [[{ salvaged: 1 }]],
      });
      const original = fetchMock.getMockImplementation();
      if (!original) throw new Error("fetch stub has no implementation");
      fetchMock.mockImplementation(async (input, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.includes("/datasets/") && flaky.current) {
          flaky.current = false;
          calls.push({ url, method: init?.method ?? "GET" });
          return jsonResponse({ error: "rate limited" }, 429);
        }
        return original(input, init);
      });

      const promise = runApifyActor(baseArgs);
      await vi.advanceTimersByTimeAsync(6_000);
      const outcome = await promise;

      expect(outcome).toEqual({
        items: [{ salvaged: 1 }],
        status: "TIMED-OUT",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the run before rethrowing a fatal poll error", async () => {
    stubApify({
      polls: [jsonResponse({ error: "no such run" }, 404)],
    });

    await expect(runApifyActor(baseArgs)).rejects.toThrow("Apify 404");
    expect(
      calls.some(
        (c) => c.method === "POST" && c.url.pathname.endsWith("/abort"),
      ),
    ).toBe(true);
  });

  it("rethrows a non-retryable poll error", async () => {
    stubApify({
      polls: [jsonResponse({ error: "no such run" }, 404)],
    });

    await expect(runApifyActor(baseArgs)).rejects.toThrow("Apify 404");
  });

  it("fails fast without a token", async () => {
    const fetchMock = stubApify({ polls: [] });

    await expect(
      runApifyActor({ ...baseArgs, token: "" }),
    ).rejects.toBeInstanceOf(ApifyApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
