import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { logger } from "@infra/logger";
import type { HtmlBundle } from "./bundle";
import type {
  HtmlTask,
  HtmlTaskReply,
  PreparedPage,
  RenderedPage,
  TemplatedPage,
} from "./html-worker-tasks";
import {
  type CheckedHtmlBundle,
  HtmlRejectError,
  isTextBundleFile,
} from "./parse-html";
import type { RenderPageErrorCode } from "./render-html";
import { type HtmlFieldSpan, SpliceError } from "./splice-markers";

// Runs every parse of an HTML-CV page — the upload check, splicing, each
// render — in a worker thread with a deadline and a heap cap. Parsing cost
// has bounds html-tree.ts enforces during the parse (elements, nesting
// depth), but what remains grows with the page, and an upload may be tens of
// megabytes. Off the main thread, a crafted page costs one worker, not the
// server's event loop; tasks run one at a time, so parallel uploads and
// renders cannot multiply the heap cap.

// Measured: a typical one-page CV checks in ~35 ms; a 14 MB single-file page
// embedding a font and a photo as data: URIs takes ~2.8 s and ~0.8 GB of heap.
// Extrapolating, the heap cap admits pages up to roughly 18 MB of mostly
// embedded fonts and images — those belong in the zip as files — and the
// deadline leaves room for a busy box.
const TASK_TIMEOUT_MS = 10_000;
const TASK_HEAP_MB = 1024;

const TASKS_URL = new URL("./html-worker-tasks.ts", import.meta.url).href;
// Resolved here rather than in the worker, whose bare specifiers would
// resolve against the process's working directory.
const TSX_API_PATH = createRequire(import.meta.url).resolve("tsx/esm/api");

// The worker loads the TypeScript module through tsx, which the server
// already runs under (and which vitest's workers do not provide).
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  try {
    const { tsImport } = require(workerData.tsxApiPath);
    const { runHtmlTask } = await tsImport(workerData.moduleUrl, workerData.moduleUrl);
    parentPort.postMessage(runHtmlTask(workerData.task));
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: { kind: "other", name: error && error.name, message: String((error && error.stack) || error) },
    });
  }
})();
`;

export interface HtmlTaskOptions {
  /** Default: TASK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Default: TASK_HEAP_MB. */
  maxHeapMb?: number;
}

export interface PreparedHtmlBundle extends CheckedHtmlBundle {
  /** The cleaned entry page's visible text (the gate's T0). */
  text: string;
  /** The page's segments, as the LLM is shown them. */
  segments: PreparedPage["segments"];
}

export type HtmlRenderErrorCode =
  | RenderPageErrorCode
  | "RENDER_TOO_COSTLY"
  | "RENDER_WORKER_FAILED";

export type HtmlRenderResult =
  | { ok: true; html: string }
  | {
      ok: false;
      code: HtmlRenderErrorCode;
      fieldId?: string;
      message: string;
    };

/**
 * The upload check (checkHtmlBundleUnbounded) plus the cleaned page's text
 * and segments, bounded in time and memory. Rejects with the check's own
 * HtmlRejectError, with CHECK_TOO_COSTLY when the page could not be checked
 * within the budget, or with a plain Error when the worker itself fails (a
 * bug, not the page).
 */
export async function checkHtmlBundleBounded(
  bundle: HtmlBundle,
  opts: HtmlTaskOptions = {},
): Promise<PreparedHtmlBundle> {
  const outcome = await runTask(
    { kind: "prepare", bundle: bundleForCheck(bundle) },
    opts,
  );
  const prepared = uploadResult(outcome) as PreparedPage;
  const files = new Map(bundle.files);
  files.set(bundle.entry, new TextEncoder().encode(prepared.entryHtml));
  return {
    bundle: { ...bundle, files },
    entryHtml: prepared.entryHtml,
    text: prepared.text,
    segments: prepared.segments,
  };
}

/**
 * Splices the LLM's field spans into the checked page and renders the
 * template with its defaults. Rejects with the SpliceError to feed back to
 * the LLM, with CHECK_TOO_COSTLY past the budget, or with a plain Error when
 * the worker fails; a defaults render that fails is in the result.
 */
export async function templateHtmlPage(
  entryHtml: string,
  fields: HtmlFieldSpan[],
  opts: HtmlTaskOptions = {},
): Promise<TemplatedPage> {
  const outcome = await runTask({ kind: "template", entryHtml, fields }, opts);
  return uploadResult(outcome) as TemplatedPage;
}

/**
 * Renders a template with the given values (renderPage). Never rejects:
 * every failure, the worker's included, is in the result.
 */
export async function renderHtmlPage(
  templatedHtml: string,
  defaults: ReadonlyMap<string, string>,
  overrides: ReadonlyMap<string, string>,
  opts: HtmlTaskOptions = {},
): Promise<HtmlRenderResult> {
  const outcome = await runTask(
    {
      kind: "render",
      templatedHtml,
      defaults: new Map(defaults),
      overrides: new Map(overrides),
    },
    opts,
  ).catch((error: unknown) => ({ kind: "failed" as const, error }));
  if (outcome.kind === "reply" && outcome.reply.ok) {
    const rendered = outcome.reply.result as RenderedPage;
    if (rendered.ok) return { ok: true, html: rendered.html };
    const { code, fieldId, message } = rendered;
    return fieldId === undefined
      ? { ok: false, code, message }
      : { ok: false, code, fieldId, message };
  }
  if (tooCostly(outcome)) {
    return {
      ok: false,
      code: "RENDER_TOO_COSTLY",
      message:
        "The CV is too large or complex to render; shorten the tailored values.",
    };
  }
  logger.error("HTML render worker failed", { detail: describe(outcome) });
  return {
    ok: false,
    code: "RENDER_WORKER_FAILED",
    message: "The CV could not be rendered because of an internal error.",
  };
}

type TaskOutcome =
  | { kind: "reply"; reply: HtmlTaskReply }
  /** The deadline passed, or the heap ran out. */
  | { kind: "too-costly" }
  /**
   * The worker failed (any error but running out of heap), exited without
   * replying, or — for a render, whose caller catches it — could not start.
   */
  | { kind: "failed"; error: unknown };

/** An upload task's result, or its failure thrown as the upload words it. */
function uploadResult(
  outcome: TaskOutcome,
): PreparedPage | TemplatedPage | RenderedPage {
  if (outcome.kind === "reply" && outcome.reply.ok) return outcome.reply.result;
  if (outcome.kind === "reply" && !outcome.reply.ok) {
    const error = outcome.reply.error;
    if (error.kind === "reject") {
      throw new HtmlRejectError(error.message, error.code);
    }
    if (error.kind === "splice") {
      throw new SpliceError(
        error.message,
        error.code,
        error.fieldId,
        error.reason,
      );
    }
  }
  if (tooCostly(outcome)) {
    throw new HtmlRejectError(
      "This page is too large or complex to check. Keep fonts and images as separate files in a zip rather than inside the page, and simplify the markup.",
      "CHECK_TOO_COSTLY",
    );
  }
  throw new Error(`HTML task failed: ${describe(outcome)}`);
}

/**
 * The deadline passed, the heap ran out, or the task hit a RangeError: a
 * stack or allocation limit, almost always the page's size or shape (logged
 * in case it is a bug).
 */
function tooCostly(outcome: TaskOutcome): boolean {
  if (outcome.kind === "too-costly") return true;
  if (
    outcome.kind === "reply" &&
    !outcome.reply.ok &&
    outcome.reply.error.kind === "other" &&
    outcome.reply.error.name === "RangeError"
  ) {
    logger.warn("HTML task hit a RangeError", {
      detail: outcome.reply.error.message,
    });
    return true;
  }
  return false;
}

function describe(outcome: TaskOutcome): string {
  if (outcome.kind === "reply" && !outcome.reply.ok) {
    return outcome.reply.error.message;
  }
  if (outcome.kind === "failed") {
    return outcome.error instanceof Error
      ? outcome.error.message
      : String(outcome.error);
  }
  return outcome.kind;
}

/**
 * The bytes the check needs: text files whole, any other file's first 4 KB
 * (enough to tell an SVG). Copied, so a file that is a view into the whole
 * upload does not send the whole upload.
 */
function bundleForCheck(bundle: HtmlBundle): HtmlBundle {
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of bundle.files) {
    files.set(
      path,
      path === bundle.entry || isTextBundleFile(path)
        ? new Uint8Array(data)
        : new Uint8Array(data.subarray(0, 4096)),
    );
  }
  return { ...bundle, files };
}

// One task at a time; each one's deadline starts when its worker does.
let queue: Promise<unknown> = Promise.resolve();

function runTask(task: HtmlTask, opts: HtmlTaskOptions): Promise<TaskOutcome> {
  const started = queue.then(() => startTask(task, opts));
  // The next task starts once this one's worker has exited, not merely
  // settled: a timed-out worker still holds its heap while it is torn down.
  queue = started.then(
    (running) => running.exited,
    () => undefined,
  );
  return started.then((running) => running.outcome);
}

interface RunningTask {
  outcome: Promise<TaskOutcome>;
  /** Settles when the worker thread has exited. */
  exited: Promise<void>;
}

function startTask(task: HtmlTask, opts: HtmlTaskOptions): RunningTask {
  const timeoutMs = opts.timeoutMs ?? TASK_TIMEOUT_MS;
  let exited: Promise<void> = Promise.resolve();
  const outcome = new Promise<TaskOutcome>((resolve) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        moduleUrl: TASKS_URL,
        tsxApiPath: TSX_API_PATH,
        task,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: opts.maxHeapMb ?? TASK_HEAP_MB,
      },
    });
    exited = new Promise((done) => worker.once("exit", () => done()));
    let settled = false;
    const finish = (result: TaskOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: "too-costly" }), timeoutMs);
    worker.on("message", (reply: HtmlTaskReply) =>
      finish({ kind: "reply", reply }),
    );
    worker.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? { kind: "too-costly" }
          : { kind: "failed", error },
      ),
    );
    worker.on("exit", (code) =>
      finish({
        kind: "failed",
        error: new Error(`worker exited with code ${code}`),
      }),
    );
  });
  return { outcome, exited };
}
