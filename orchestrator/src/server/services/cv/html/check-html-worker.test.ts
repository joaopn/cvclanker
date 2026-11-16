// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { HtmlBundle } from "./bundle";
import { checkHtmlBundleBounded } from "./check-html-worker";

// Every worker's start and exit, in order, to see that a check starts only
// once the previous worker has exited.
const workerEvents = vi.hoisted(() => [] as string[]);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class LoggedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workerEvents.push("start");
      this.once("exit", () => workerEvents.push("exit"));
    }
  }
  return { ...actual, Worker: LoggedWorker };
});

import { HtmlRejectError } from "./parse-html";

const TEST_TIMEOUT_MS = 60_000;

function single(html: string): HtmlBundle {
  return {
    shape: "file",
    files: new Map([["index.html", new TextEncoder().encode(html)]]),
    entry: "index.html",
  };
}

async function rejection(promise: Promise<unknown>): Promise<HtmlRejectError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HtmlRejectError) return error;
    throw error;
  }
  throw new Error("expected the check to reject");
}

describe("checkHtmlBundleBounded", () => {
  it(
    "checks a page in a worker and returns it cleaned up",
    async () => {
      const result = await checkHtmlBundleBounded(
        single('<!doctype html><link rel="icon" href="f.ico"><p>Jane</p>'),
      );
      expect(result.entryHtml).toContain("<p>Jane</p>");
      expect(result.entryHtml).not.toContain("icon");
      expect(
        new TextDecoder().decode(result.bundle.files.get("index.html")),
      ).toBe(result.entryHtml);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "passes the check's own rejects through",
    async () => {
      const error = await rejection(
        checkHtmlBundleBounded(single("<!doctype html><script>1</script>")),
      );
      expect(error.code).toBe("SCRIPT");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops a check that runs past its deadline, without blocking",
    async () => {
      // Text tokens re-checking a 500-deep stack: ~2 s of parsing.
      const slow = `<!doctype html><b>${"<span>".repeat(500)}${"a ".repeat(1_000_000)}`;
      let ticks = 0;
      const ticker = setInterval(() => ticks++, 10);
      const started = Date.now();
      const error = await rejection(
        checkHtmlBundleBounded(single(slow), { timeoutMs: 500 }),
      );
      clearInterval(ticker);
      expect(error.code).toBe("CHECK_TOO_COSTLY");
      expect(Date.now() - started).toBeLessThan(1_500);
      // The main thread kept running while the worker parsed.
      expect(ticks).toBeGreaterThan(10);
    },
    TEST_TIMEOUT_MS,
  );

  it("runs checks one at a time, each deadline starting with its own check", async () => {
    // ~5 s of parsing (idle box; longer under load): longer than the second
    // check's whole deadline, so a deadline that started while queued would
    // time the second one out. Its own deadline is generous, so a loaded box
    // cannot time it out.
    const slow = `<!doctype html><b>${"<span>".repeat(500)}${"a ".repeat(3_000_000)}`;
    const order: string[] = [];
    const results = await Promise.allSettled([
      checkHtmlBundleBounded(single(slow), { timeoutMs: 90_000 }).then(() =>
        order.push("slow"),
      ),
      checkHtmlBundleBounded(single("<!doctype html><p>x</p>"), {
        timeoutMs: 4_000,
      }).then(() => order.push("fast")),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(order).toEqual(["slow", "fast"]);
  }, 120_000); // The slow check alone may take tens of seconds on a loaded box.

  it(
    "starts the next check only once the previous worker has exited",
    async () => {
      // A worker that times out is busy parsing and cannot exit before it is
      // terminated, so a queue that moved on at settle would log
      // start, start, exit, exit.
      const slow = `<!doctype html><b>${"<span>".repeat(500)}${"a ".repeat(1_000_000)}`;
      // Workers from earlier tests may still be exiting.
      const exitedAll = () =>
        workerEvents.filter((event) => event === "start").length ===
        workerEvents.filter((event) => event === "exit").length;
      await expect.poll(exitedAll, { timeout: 10_000 }).toBe(true);
      workerEvents.length = 0;
      await Promise.allSettled([
        checkHtmlBundleBounded(single(slow), { timeoutMs: 300 }),
        checkHtmlBundleBounded(single("<!doctype html><p>x</p>")),
      ]);
      await expect.poll(() => workerEvents.length, { timeout: 10_000 }).toBe(4);
      expect(workerEvents).toEqual(["start", "exit", "start", "exit"]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "checks a stylesheet whole, past the first 4 KB",
    async () => {
      const css = `${"/* padding */\n".repeat(400)}p { background: url(https://x.example/late.png); }`;
      const error = await rejection(
        checkHtmlBundleBounded({
          shape: "bundle",
          files: new Map([
            [
              "index.html",
              new TextEncoder().encode(
                '<!doctype html><link rel="stylesheet" href="a.css"><p>x</p>',
              ),
            ],
            ["a.css", new TextEncoder().encode(css)],
          ]),
          entry: "index.html",
        }),
      );
      expect(error.code).toBe("REMOTE_REFERENCES");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops a check that runs out of its heap",
    async () => {
      const blob = Buffer.alloc(6_000_000, 7).toString("base64");
      const large = `<!doctype html><img src="data:image/png;base64,${blob}"><p>x</p>`;
      // The same limit lets an ordinary page through, so the reject below is
      // the page's cost, not the worker failing to start.
      await expect(
        checkHtmlBundleBounded(single("<!doctype html><p>x</p>"), {
          maxHeapMb: 128,
        }),
      ).resolves.toBeDefined();
      // A generous deadline, so only the heap can stop it.
      const error = await rejection(
        checkHtmlBundleBounded(single(large), {
          maxHeapMb: 128,
          timeoutMs: 60_000,
        }),
      );
      expect(error.code).toBe("CHECK_TOO_COSTLY");
    },
    TEST_TIMEOUT_MS,
  );
});
