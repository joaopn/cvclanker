// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { HtmlBundle } from "./bundle";
import {
  checkHtmlBundleBounded,
  renderHtmlPage,
  templateHtmlPage,
} from "./html-worker";

// Every worker's start and exit, in order, to see that a check starts only
// once the previous worker has exited.
const workerEvents = vi.hoisted(() => [] as string[]);
// Set to make the next worker fail to start, stop before it replies, or
// reply with something else.
const startFails = vi.hoisted(() => ({ next: false }));
const crash = vi.hoisted(() => ({ next: false }));
const fakeReply = vi.hoisted(() => ({ next: undefined as unknown }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class LoggedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (startFails.next) {
        startFails.next = false;
        throw new Error("cannot start a worker");
      }
      super(...args);
      if (crash.next) {
        crash.next = false;
        void this.terminate();
      }
      const reply = fakeReply.next;
      if (reply !== undefined) {
        fakeReply.next = undefined;
        const emit = this.emit.bind(this);
        this.emit = (event: string | symbol, ...rest: unknown[]) =>
          event === "message" ? emit(event, reply) : emit(event, ...rest);
      }
      workerEvents.push("start");
      this.once("exit", () => workerEvents.push("exit"));
    }
  }
  return { ...actual, Worker: LoggedWorker };
});

import { HtmlRejectError } from "./parse-html";
import { SpliceError } from "./splice-markers";

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

describe("the template and render tasks", () => {
  const upload =
    '<!doctype html><p>Built <b>Kafka</b> pipelines</p><p><a href="https://x.test/">Site</a></p>';

  it(
    "prepares a page's segments, splices it and renders the defaults back to it",
    async () => {
      const prepared = await checkHtmlBundleBounded(single(upload));
      expect(prepared.segments).toEqual([
        { segmentId: 0, text: "Built Kafka pipelines" },
        { segmentId: 1, text: "Site" },
      ]);
      const templated = await templateHtmlPage(prepared.entryHtml, [
        { id: "b1", value: "Built Kafka pipelines", segmentId: 0 },
        { id: "site", value: "Site", segmentId: 1 },
      ]);
      expect(templated.templatedHtml).toContain("<p>⟦b1⟧</p>");
      expect([...templated.defaults]).toEqual([
        ["b1", "Built <b>Kafka</b> pipelines"],
        ["site", "Site"],
      ]);
      expect(templated.insideLinks).toEqual(["site"]);
      expect(templated.rendered).toEqual({
        ok: true,
        html: prepared.entryHtml,
      });

      expect(
        await renderHtmlPage(
          templated.templatedHtml,
          templated.defaults,
          new Map([["b1", "Built <b>Spark</b> jobs"]]),
        ),
      ).toEqual({
        ok: true,
        html: prepared.entryHtml.replace(
          "Kafka</b> pipelines",
          "Spark</b> jobs",
        ),
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rebuilds a SpliceError, with its field and reason",
    async () => {
      const error = await templateHtmlPage(
        '<!doctype html><html><head></head><body><p>a <img src="a.png"> b</p></body></html>',
        [{ id: "f", value: "a b", segmentId: 0 }],
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      // The span covers the image between its two words.
      expect(error).toBeInstanceOf(SpliceError);
      expect(error).toMatchObject({
        code: "SPAN_MARKUP_NOT_ALLOWED",
        fieldId: "f",
        reason: "TAG_NOT_ALLOWED",
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns a defaults render that fails in the result",
    async () => {
      // Not a checked page: the upload check refuses a marker character.
      const templated = await templateHtmlPage(
        '<!doctype html><p title="⟦x⟧">a</p>',
        [],
      );
      expect(templated.rendered).toMatchObject({
        ok: false,
        code: "TEMPLATE_INVALID",
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "words a template past its budget as the upload's CHECK_TOO_COSTLY",
    async () => {
      const error = await rejection(
        templateHtmlPage("<!doctype html><p>x</p>", [], { timeoutMs: 1 }),
      );
      expect(error.code).toBe("CHECK_TOO_COSTLY");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "returns every render failure as a value",
    async () => {
      const templatedHtml =
        "<!doctype html><html><head></head><body><p>⟦x⟧</p></body></html>";
      const defaults = new Map([["x", "a"]]);
      expect(
        await renderHtmlPage(
          templatedHtml,
          defaults,
          new Map([["x", "<i>b</i>"]]),
        ),
      ).toEqual({
        ok: false,
        code: "VALUE_NOT_ALLOWED",
        fieldId: "x",
        message:
          'Field "x": the value uses <i>, which this CV\'s fields do not use.',
      });
      expect(
        await renderHtmlPage(templatedHtml, defaults, new Map(), {
          timeoutMs: 1,
        }),
      ).toMatchObject({ ok: false, code: "RENDER_TOO_COSTLY" });
      crash.next = true;
      expect(
        await renderHtmlPage(templatedHtml, defaults, new Map()),
      ).toMatchObject({ ok: false, code: "RENDER_WORKER_FAILED" });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("worker failures", () => {
  const templatedHtml =
    "<!doctype html><html><head></head><body><p>⟦x⟧</p></body></html>";
  const defaults = new Map([["x", "a"]]);
  const other = (name: string) => ({
    ok: false,
    error: { kind: "other", name, message: `${name}: boom` },
  });

  it(
    "words a RangeError in a task as the page's cost",
    async () => {
      fakeReply.next = other("RangeError");
      expect(
        await renderHtmlPage(templatedHtml, defaults, new Map()),
      ).toMatchObject({ ok: false, code: "RENDER_TOO_COSTLY" });
      fakeReply.next = other("RangeError");
      expect(
        (await rejection(checkHtmlBundleBounded(single("<p>x</p>")))).code,
      ).toBe("CHECK_TOO_COSTLY");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports any other failure as the worker's, not the page's",
    async () => {
      fakeReply.next = other("TypeError");
      expect(
        await renderHtmlPage(templatedHtml, defaults, new Map()),
      ).toMatchObject({ ok: false, code: "RENDER_WORKER_FAILED" });
      startFails.next = true;
      expect(
        await renderHtmlPage(templatedHtml, defaults, new Map()),
      ).toMatchObject({ ok: false, code: "RENDER_WORKER_FAILED" });
      // The queue carries on after a worker that never started.
      expect(
        await renderHtmlPage(templatedHtml, defaults, new Map()),
      ).toMatchObject({ ok: true });
      for (const fail of [
        () => {
          fakeReply.next = other("TypeError");
        },
        () => {
          crash.next = true;
        },
      ]) {
        fail();
        const error = await templateHtmlPage("<p>x</p>", []).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(HtmlRejectError);
        expect(error).not.toBeInstanceOf(SpliceError);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
