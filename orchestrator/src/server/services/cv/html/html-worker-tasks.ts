import type { HtmlBundle } from "./bundle";
import { parsePage } from "./html-tree";
import type { MarkupRefusal } from "./inline-markup";
import { segmentsOf } from "./page-text";
import {
  checkHtmlBundleUnbounded,
  type HtmlRejectCode,
  HtmlRejectError,
} from "./parse-html";
import { type RenderPageFailure, renderPage } from "./render-html";
import {
  type HtmlFieldSpan,
  SpliceError,
  type SpliceErrorCode,
  spliceMarkers,
} from "./splice-markers";

// The tasks html-worker.ts runs in a worker thread, one per pipeline stage.
// Each one parses a page, so none may run on the main thread (html-tree.ts).
// Replies are plain data: typed errors cross the thread boundary as fields
// and are rebuilt on the main thread.

export type HtmlTask =
  | { kind: "prepare"; bundle: HtmlBundle }
  | { kind: "template"; entryHtml: string; fields: HtmlFieldSpan[] }
  | {
      kind: "render";
      templatedHtml: string;
      defaults: Map<string, string>;
      overrides: Map<string, string>;
    };

/** A segment as the LLM sees it. */
export interface SegmentText {
  segmentId: number;
  text: string;
}

export interface PreparedPage {
  /** The cleaned entry page. */
  entryHtml: string;
  segments: SegmentText[];
}

export type RenderedPage = { ok: true; html: string } | RenderPageFailure;

export interface TemplatedPage {
  templatedHtml: string;
  defaults: Map<string, string>;
  insideLinks: string[];
  /** The template rendered with its defaults (the upload gate compares it). */
  rendered: RenderedPage;
}

export type HtmlTaskError =
  | { kind: "reject"; code: HtmlRejectCode; message: string }
  | {
      kind: "splice";
      code: SpliceErrorCode;
      fieldId: string;
      reason: MarkupRefusal | undefined;
      message: string;
    }
  /** Anything else: a bug, or (RangeError) a stack or allocation limit. */
  | { kind: "other"; name: string | undefined; message: string };

export type HtmlTaskReply =
  | { ok: true; result: PreparedPage | TemplatedPage | RenderedPage }
  | { ok: false; error: HtmlTaskError };

/** Runs one task; never throws. */
export function runHtmlTask(task: HtmlTask): HtmlTaskReply {
  try {
    return { ok: true, result: run(task) };
  } catch (error) {
    return { ok: false, error: errorAsData(error) };
  }
}

function run(task: HtmlTask): PreparedPage | TemplatedPage | RenderedPage {
  switch (task.kind) {
    case "prepare": {
      const checked = checkHtmlBundleUnbounded(task.bundle);
      const document = checked.page.document;
      return {
        entryHtml: checked.entryHtml,
        segments: segmentsOf(document).map(({ segmentId, text }) => ({
          segmentId,
          text,
        })),
      };
    }
    case "template": {
      const spliced = spliceMarkers(parsePage(task.entryHtml), task.fields);
      const rendered = renderPage(
        spliced.templatedHtml,
        spliced.defaults,
        new Map(),
      );
      return {
        templatedHtml: spliced.templatedHtml,
        defaults: spliced.defaults,
        insideLinks: spliced.insideLinks,
        rendered: rendered.ok ? { ok: true, html: rendered.html } : rendered,
      };
    }
    case "render": {
      const rendered = renderPage(
        task.templatedHtml,
        task.defaults,
        task.overrides,
      );
      return rendered.ok ? { ok: true, html: rendered.html } : rendered;
    }
  }
}

function errorAsData(error: unknown): HtmlTaskError {
  if (error instanceof HtmlRejectError) {
    return { kind: "reject", code: error.code, message: error.message };
  }
  if (error instanceof SpliceError) {
    return {
      kind: "splice",
      code: error.code,
      fieldId: error.fieldId,
      reason: error.reason,
      message: error.message,
    };
  }
  const name = error instanceof Error ? error.name : undefined;
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return { kind: "other", name, message };
}
