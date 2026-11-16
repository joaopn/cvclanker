import type {
  CvField,
  CvFieldOverrides,
  CvUploadPipelineAttempt,
} from "@shared/types";
import { HtmlBundleError, openHtmlBundle, packHtmlBundle } from "./bundle";
import {
  checkHtmlBundleBounded,
  type PreparedHtmlBundle,
  templateHtmlPage,
} from "./html-worker";
import type { TemplatedPage } from "./html-worker-tasks";
import {
  type HtmlExtractField,
  type HtmlExtractPreviousAttempt,
  llmHtmlExtract,
} from "./llm-html-extract";
import { HtmlRejectError } from "./parse-html";
import { RenderHtmlPdfError, renderHtmlToPdf } from "./render-html-pdf";
import { SpliceError } from "./splice-markers";
import { openStoredHtmlCvBundle } from "./stored-html-cv";

/**
 * The HTML acceptance gate (the analog of docx-upload-pipeline.ts): open
 * and check the upload → render the cleaned page to PDF → extract loop (LLM
 * span selection → splice → the defaults rendered back must be the cleaned
 * page byte for byte), ≤N attempts, hard reject on exhaustion.
 *
 * The failure shape uses the LaTeX stage vocabulary, as the Word pipeline
 * does: open and check rejects → "flatten", the PDF render → "compile-
 * original", the loop → "extract-loop". The caller persists the result,
 * including `originalArchive`: the cleaned bundle, stored in place of the
 * upload so every later render works on what was checked.
 */

const DEFAULT_MAX_RETRIES = 3;

export interface HtmlUploadPipelineArgs {
  archive: Uint8Array;
  /** Extract-loop attempts. Default 3. Clamped to [1, 10]. */
  maxRetries?: number;
  /** Per-CV system-prompt override, forwarded to llm-html-extract. */
  extractionPrompt?: string;
  /** Expanded-archive byte cap for an upload. */
  maxExpandedBytes: number;
  /**
   * The archive is one this server stored (re-extract): opened as packed,
   * with no top-folder strip and no size cap (openStoredHtmlBundle).
   */
  stored?: boolean;
}

export interface HtmlUploadPipelineSuccess {
  ok: true;
  /** The page's segments, one per line — the HTML meaning of flattened_tex. */
  flattenedTex: string;
  /** JSON envelope {"html", "insideLinks"} — the HTML meaning of templated_tex. */
  templatedTex: string;
  /** Each value is its span's markup, as in the page. */
  fields: CvField[];
  defaultFieldValues: CvFieldOverrides;
  personalBrief: string;
  compileStderr: string;
  /** 1-indexed accepting attempt number. */
  compileAttempts: number;
  attempts: CvUploadPipelineAttempt[];
  /** The cleaned bundle, in the uploaded shape: what the caller stores. */
  originalArchive: Uint8Array;
}

export interface HtmlUploadPipelineFailure {
  ok: false;
  stage: "flatten" | "compile-original" | "extract-loop";
  message: string;
  /** HtmlBundleError or HtmlRejectError code, or NO_TEXT, when stage === "flatten". */
  flattenCode?: string;
  /** The requests the bundle could not answer, or the renderer's message. */
  originalCompileStderr?: string;
  /** Per-attempt log when stage === "extract-loop". */
  attempts?: CvUploadPipelineAttempt[];
}

export type HtmlUploadPipelineResult =
  | HtmlUploadPipelineSuccess
  | HtmlUploadPipelineFailure;

export async function runHtmlUploadPipeline(
  args: HtmlUploadPipelineArgs,
): Promise<HtmlUploadPipelineResult> {
  const maxRetries = clampRetries(args.maxRetries ?? DEFAULT_MAX_RETRIES);

  // Stage 1: open and check (rejects, clean-up, the page reading back to
  // itself), all parsing in the bounded worker.
  let prepared: PreparedHtmlBundle;
  try {
    prepared = await checkHtmlBundleBounded(openUpload(args));
  } catch (error) {
    if (error instanceof HtmlBundleError || error instanceof HtmlRejectError) {
      return {
        ok: false,
        stage: "flatten",
        message: error.message,
        flattenCode: error.code,
      };
    }
    throw error;
  }
  if (prepared.segments.length === 0) {
    return {
      ok: false,
      stage: "flatten",
      message:
        "The page has no text that could be tailored (text in hidden elements, <pre>, <textarea>, SVG or MathML, among others, is not offered).",
      flattenCode: "NO_TEXT",
    };
  }

  // Stage 2: the renderability proof. The PDF is discarded; previews render
  // on demand. The extract loop's accepted page is these same bytes, so it
  // needs no render of its own.
  try {
    await renderHtmlToPdf({
      files: prepared.bundle.files,
      entry: prepared.bundle.entry,
    });
  } catch (error) {
    if (error instanceof RenderHtmlPdfError) {
      return {
        ok: false,
        stage: "compile-original",
        message: `Your CV failed to render to PDF: ${error.message}`,
        originalCompileStderr:
          error.unansweredRequests.length > 0
            ? error.unansweredRequests.join("\n")
            : error.message,
      };
    }
    throw error;
  }

  // Stage 3: the extract loop.
  const attempts: CvUploadPipelineAttempt[] = [];
  let previousAttempt: HtmlExtractPreviousAttempt | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await runOneAttempt({
      attempt,
      prepared,
      extractionPrompt: args.extractionPrompt,
      previousAttempt,
    });
    attempts.push(result.record);

    if (result.kind === "success") {
      return {
        ok: true,
        flattenedTex: prepared.segments.map((s) => s.text).join("\n"),
        templatedTex: result.templatedTex,
        fields: result.fields,
        defaultFieldValues: result.defaultFieldValues,
        personalBrief: result.personalBrief,
        compileStderr: "",
        compileAttempts: attempt,
        attempts,
        originalArchive: packHtmlBundle(prepared.bundle),
      };
    }
    if (result.kind === "stop") break;
    previousAttempt = result.previousForRetry;
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    stage: "extract-loop",
    message: `Failed to produce a valid template after ${attempts.length} attempt(s). The most recent failure was: ${last?.failureMessage ?? "unknown"}`,
    attempts,
  };
}

interface AttemptArgs {
  attempt: number;
  prepared: PreparedHtmlBundle;
  extractionPrompt?: string;
  previousAttempt?: HtmlExtractPreviousAttempt;
}

type AttemptResult =
  | {
      kind: "success";
      record: CvUploadPipelineAttempt;
      templatedTex: string;
      fields: CvField[];
      defaultFieldValues: CvFieldOverrides;
      personalBrief: string;
    }
  | {
      kind: "failure";
      record: CvUploadPipelineAttempt;
      previousForRetry: HtmlExtractPreviousAttempt | undefined;
    }
  /** A failure another attempt cannot fix: the loop ends. */
  | { kind: "stop"; record: CvUploadPipelineAttempt };

async function runOneAttempt(args: AttemptArgs): Promise<AttemptResult> {
  // Records carry no template: a single-file page can be megabytes of
  // embedded fonts and images, and the attempt log is returned per attempt.
  const record = (
    fields: CvField[],
    failureKind: CvUploadPipelineAttempt["failureKind"],
    failureMessage: string | null,
    contentDiff: string | null = null,
  ): CvUploadPipelineAttempt => ({
    attempt: args.attempt,
    templatedTex: "",
    fields,
    failureKind,
    failureMessage,
    compileStderr: null,
    contentDiff,
  });

  // 3a: span selection. Any error becomes an "llm" record, as on the Word
  // path: a deterministic infra failure burns its attempts and surfaces in
  // the attempt log rather than as an opaque 500.
  let extracted: { fields: HtmlExtractField[]; personalBrief: string };
  try {
    extracted = await llmHtmlExtract({
      segments: args.prepared.segments,
      extractionPrompt: args.extractionPrompt,
      previousAttempt: args.previousAttempt,
    });
  } catch (error) {
    return {
      kind: "failure",
      record: record(
        [],
        "llm",
        error instanceof Error ? error.message : String(error),
      ),
      previousForRetry: undefined,
    };
  }
  const llmFields: CvField[] = extracted.fields.map(({ id, role, value }) => ({
    id,
    role,
    value,
  }));

  // 3b: splice, and render the template with its defaults.
  let templated: TemplatedPage;
  try {
    templated = await templateHtmlPage(
      args.prepared.entryHtml,
      extracted.fields,
    );
  } catch (error) {
    if (error instanceof SpliceError) {
      // The selection, not the page, failed (the Word vocabulary: "llm").
      return {
        kind: "failure",
        record: record(llmFields, "llm", error.message),
        previousForRetry: {
          fields: extracted.fields,
          failureKind: "splice",
          detail: error.message,
        },
      };
    }
    if (error instanceof HtmlRejectError) {
      // Over the time or memory budget: the same page would be again.
      return {
        kind: "stop",
        record: record(llmFields, "render", error.message),
      };
    }
    throw error;
  }
  if (!templated.rendered.ok) {
    return {
      kind: "failure",
      record: record(llmFields, "render", templated.rendered.message),
      previousForRetry: {
        fields: extracted.fields,
        failureKind: "render",
        detail: templated.rendered.message,
      },
    };
  }

  // 3c: the gate. The defaults rendered back must be the checked page byte
  // for byte (and so its text is too).
  const { html } = templated.rendered;
  if (html !== args.prepared.entryHtml) {
    const contentDiff = firstDifference(args.prepared.entryHtml, html);
    return {
      kind: "failure",
      record: record(
        llmFields,
        "content-diff",
        "Putting the fields' own values back did not reproduce the page.",
        contentDiff,
      ),
      previousForRetry: {
        fields: extracted.fields,
        failureKind: "content-diff",
        detail: contentDiff,
      },
    };
  }

  // Each field's value is the markup its span covered, so fields and
  // defaults agree (as on the LaTeX and Word paths). Only this copy changes:
  // the retry context above keeps the LLM's own plain-text values.
  const fields = llmFields.map((field) => ({
    ...field,
    value: templated.defaults.get(field.id) ?? field.value,
  }));
  const defaultFieldValues: CvFieldOverrides = Object.fromEntries(
    templated.defaults,
  );
  return {
    kind: "success",
    record: record(fields, null, null),
    templatedTex: JSON.stringify({
      html: templated.templatedHtml,
      insideLinks: templated.insideLinks,
    }),
    fields,
    defaultFieldValues,
    personalBrief: extracted.personalBrief,
  };
}

/**
 * The bundle to check. A stored archive the server packed itself must open:
 * failing to is damage on the server's side, never the user's file to fix.
 */
function openUpload(args: HtmlUploadPipelineArgs) {
  if (!args.stored) {
    return openHtmlBundle(args.archive, {
      maxExpandedBytes: args.maxExpandedBytes,
    });
  }
  return openStoredHtmlCvBundle(args.archive);
}

const DIFF_CONTEXT = 80;

/** Where two pages first differ, with some context from each. */
function firstDifference(expected: string, actual: string): string {
  let at = 0;
  while (
    at < expected.length &&
    at < actual.length &&
    expected[at] === actual[at]
  ) {
    at++;
  }
  const from = Math.max(0, at - DIFF_CONTEXT);
  return [
    `The pages differ at character ${at}.`,
    `original: …${expected.slice(from, at + DIFF_CONTEXT)}…`,
    `rendered: …${actual.slice(from, at + DIFF_CONTEXT)}…`,
  ].join("\n");
}

// The same as the LaTeX and Word pipelines' namesake (0 / Infinity / NaN → 1).
function clampRetries(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  if (value > 10) return 10;
  return Math.floor(value);
}
