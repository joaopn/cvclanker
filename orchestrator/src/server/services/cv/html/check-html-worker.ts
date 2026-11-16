import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { logger } from "@infra/logger";
import type { HtmlBundle } from "./bundle";
import {
  type CheckedHtmlBundle,
  HtmlRejectError,
  isTextBundleFile,
} from "./parse-html";

// Runs checkHtmlBundleUnbounded in a worker thread with a deadline and a heap
// cap. Parsing cost has bounds the check enforces itself (elements, nesting
// depth), but what remains grows with the page, and an upload may be tens of
// megabytes. Off the main thread, a crafted page costs one worker, not the
// server's event loop; checks run one at a time, so parallel uploads cannot
// multiply the heap cap.

// Measured: a typical one-page CV checks in ~35 ms; a 14 MB single-file page
// embedding a font and a photo as data: URIs takes ~2.8 s and ~0.8 GB of heap.
// Extrapolating, the heap cap admits pages up to roughly 18 MB of mostly
// embedded fonts and images — those belong in the zip as files — and the
// deadline leaves room for a busy box.
const CHECK_TIMEOUT_MS = 10_000;
const CHECK_HEAP_MB = 1024;

const PARSE_HTML_URL = new URL("./parse-html.ts", import.meta.url).href;
// Resolved here rather than in the worker, whose bare specifiers would
// resolve against the process's working directory.
const TSX_API_PATH = createRequire(import.meta.url).resolve("tsx/esm/api");

// The worker loads the TypeScript module through tsx, which the server
// already runs under (and which vitest's workers do not provide).
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { tsImport } = require(workerData.tsxApiPath);
  const { checkHtmlBundleUnbounded } = await tsImport(workerData.moduleUrl, workerData.moduleUrl);
  try {
    const result = checkHtmlBundleUnbounded({
      shape: workerData.shape,
      files: new Map(workerData.files),
      entry: workerData.entry,
    });
    parentPort.postMessage({ ok: true, entryHtml: result.entryHtml });
  } catch (error) {
    if (error && error.name === "HtmlRejectError") {
      parentPort.postMessage({ ok: false, code: error.code, message: error.message });
    } else {
      parentPort.postMessage({
        ok: false,
        name: error && error.name,
        message: String((error && error.stack) || error),
      });
    }
  }
})();
`;

type WorkerReply =
  | { ok: true; entryHtml: string }
  | { ok: false; code: HtmlRejectError["code"]; message: string }
  | { ok: false; code?: undefined; name?: string; message: string };

export interface CheckHtmlBundleOptions {
  /** Default: CHECK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Default: CHECK_HEAP_MB. */
  maxHeapMb?: number;
}

/**
 * checkHtmlBundleUnbounded, bounded in time and memory. Rejects with the
 * check's own HtmlRejectError, with CHECK_TOO_COSTLY when the page could not
 * be checked within the budget, or with a plain Error when the worker itself
 * fails (a bug, not the page).
 */
export function checkHtmlBundleBounded(
  bundle: HtmlBundle,
  opts: CheckHtmlBundleOptions = {},
): Promise<CheckedHtmlBundle> {
  const started = queue.then(() => startCheck(bundle, opts));
  // The next check starts once this one's worker has exited, not merely
  // settled: a timed-out worker still holds its heap while it is torn down.
  queue = started.then(
    (check) => check.exited,
    () => undefined,
  );
  return started.then((check) => check.result);
}

// One check at a time; each one's deadline starts when its worker does.
let queue: Promise<unknown> = Promise.resolve();

/**
 * The bytes the check needs: text files whole, any other file's first 4 KB
 * (enough to tell an SVG). Copied, so a file that is a view into the whole
 * upload does not send the whole upload.
 */
function filesForCheck(bundle: HtmlBundle): [string, Uint8Array][] {
  return [...bundle.files].map(([path, data]) => [
    path,
    path === bundle.entry || isTextBundleFile(path)
      ? new Uint8Array(data)
      : new Uint8Array(data.subarray(0, 4096)),
  ]);
}

interface StartedCheck {
  result: Promise<CheckedHtmlBundle>;
  /** Settles when the worker thread has exited. */
  exited: Promise<void>;
}

function startCheck(
  bundle: HtmlBundle,
  opts: CheckHtmlBundleOptions,
): StartedCheck {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  let exited: Promise<void> = Promise.resolve();
  const result = new Promise<CheckedHtmlBundle>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        moduleUrl: PARSE_HTML_URL,
        tsxApiPath: TSX_API_PATH,
        shape: bundle.shape,
        files: filesForCheck(bundle),
        entry: bundle.entry,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: opts.maxHeapMb ?? CHECK_HEAP_MB,
      },
    });
    exited = new Promise((done) => worker.once("exit", () => done()));
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      outcome();
    };
    const tooCostly = () =>
      new HtmlRejectError(
        "This page is too large or complex to check. Keep fonts and images as separate files in a zip rather than inside the page, and simplify the markup.",
        "CHECK_TOO_COSTLY",
      );
    const timer = setTimeout(
      () => finish(() => reject(tooCostly())),
      timeoutMs,
    );

    worker.on("message", (reply: WorkerReply) => {
      finish(() => {
        if (reply.ok) {
          const files = new Map(bundle.files);
          files.set(bundle.entry, new TextEncoder().encode(reply.entryHtml));
          resolve({ bundle: { ...bundle, files }, entryHtml: reply.entryHtml });
        } else if (reply.code !== undefined) {
          reject(new HtmlRejectError(reply.message, reply.code));
        } else if (reply.name === "RangeError") {
          // A stack or allocation limit inside the check — almost always the
          // page's size or shape; logged in case it is a bug.
          logger.warn("HTML check hit a RangeError", { stack: reply.message });
          reject(tooCostly());
        } else {
          reject(new Error(`HTML check failed: ${reply.message}`));
        }
      });
    });
    worker.on("error", (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? tooCostly()
            : new Error(`HTML check worker failed: ${error.message}`),
        ),
      );
    });
    worker.on("exit", (code) => {
      finish(() =>
        reject(new Error(`HTML check worker exited with code ${code}`)),
      );
    });
  });
  return { result, exited };
}
