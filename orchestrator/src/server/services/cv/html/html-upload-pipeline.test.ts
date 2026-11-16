// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openStoredHtmlBundle } from "./bundle";
import type { HtmlExtractField } from "./llm-html-extract";
import { buildZip } from "./test/zip-builder";

// The LLM is mocked; the worker, the checks and Chromium are real. Two
// switches replace one call each for the cases no real page produces.
const hooks = vi.hoisted(() => ({
  renderFails: undefined as Error | undefined,
  templateReply: undefined as (() => Promise<unknown>) | undefined,
}));

vi.mock("./llm-html-extract", () => ({ llmHtmlExtract: vi.fn() }));

vi.mock("./render-html-pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./render-html-pdf")>();
  return {
    ...actual,
    renderHtmlToPdf: (args: Parameters<typeof actual.renderHtmlToPdf>[0]) => {
      const failure = hooks.renderFails;
      hooks.renderFails = undefined;
      return failure ? Promise.reject(failure) : actual.renderHtmlToPdf(args);
    },
  };
});

vi.mock("./html-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./html-worker")>();
  return {
    ...actual,
    templateHtmlPage: (...args: Parameters<typeof actual.templateHtmlPage>) => {
      const reply = hooks.templateReply;
      hooks.templateReply = undefined;
      return reply ? reply() : actual.templateHtmlPage(...args);
    },
  };
});

import { runHtmlUploadPipeline } from "./html-upload-pipeline";
import { llmHtmlExtract } from "./llm-html-extract";
import { HtmlRejectError } from "./parse-html";
import { RenderHtmlPdfError, stopHtmlRenderer } from "./render-html-pdf";

const extract = vi.mocked(llmHtmlExtract);
const TIMEOUT = 60_000;

const PAGE =
  '<!DOCTYPE html><html><head><title>CV</title><link rel="icon" href="f.ico"></head><body><h1>Jane Doe</h1><p>Built <b>Kafka</b> pipelines</p></body></html>';
const CLEANED =
  "<!DOCTYPE html><html><head><title>CV</title></head><body><h1>Jane Doe</h1><p>Built <b>Kafka</b> pipelines</p></body></html>";

const BULLET: HtmlExtractField = {
  id: "experience.0.bullet.0",
  role: "bullet",
  value: "Built Kafka pipelines",
  segmentId: 1,
};

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function selects(...fields: HtmlExtractField[]) {
  return { fields, personalBrief: "I build pipelines." };
}

function run(archive: Uint8Array, maxRetries = 3) {
  return runHtmlUploadPipeline({
    archive,
    maxRetries,
    maxExpandedBytes: 50 * 1024 * 1024,
  });
}

afterAll(async () => {
  await stopHtmlRenderer();
});

beforeEach(() => {
  // A reset, not a clear: a one-shot reply a test did not use must not leak.
  extract.mockReset();
  hooks.renderFails = undefined;
  hooks.templateReply = undefined;
});

describe("runHtmlUploadPipeline — accepted", () => {
  it(
    "accepts on the first attempt, storing the cleaned page and the span markup",
    async () => {
      extract.mockResolvedValue(selects(BULLET));
      const result = await run(utf8(PAGE));
      if (!result.ok) throw new Error(result.message);

      expect(result.flattenedTex).toBe("Jane Doe\nBuilt Kafka pipelines");
      expect(result.fields).toEqual([
        {
          id: "experience.0.bullet.0",
          role: "bullet",
          value: "Built <b>Kafka</b> pipelines",
        },
      ]);
      expect(result.defaultFieldValues).toEqual({
        "experience.0.bullet.0": "Built <b>Kafka</b> pipelines",
      });
      expect(JSON.parse(result.templatedTex)).toEqual({
        html: CLEANED.replace(
          "<p>Built <b>Kafka</b> pipelines</p>",
          "<p>⟦experience.0.bullet.0⟧</p>",
        ),
        insideLinks: [],
      });
      expect(new TextDecoder().decode(result.originalArchive)).toBe(CLEANED);
      expect(result.personalBrief).toBe("I build pipelines.");
      expect(result.compileAttempts).toBe(1);
      expect(result.attempts).toEqual([
        {
          attempt: 1,
          templatedTex: "",
          fields: result.fields,
          failureKind: null,
          failureMessage: null,
          compileStderr: null,
          contentDiff: null,
        },
      ]);
      expect(extract).toHaveBeenCalledWith({
        segments: [
          { segmentId: 0, text: "Jane Doe" },
          { segmentId: 1, text: "Built Kafka pipelines" },
        ],
        extractionPrompt: undefined,
        previousAttempt: undefined,
      });
    },
    TIMEOUT,
  );

  it(
    "keeps a zip a zip, opening as stored to the same entry, however deep",
    async () => {
      extract.mockResolvedValue(selects(BULLET));
      const archive = buildZip([
        { name: "outer/inner/index.html", data: PAGE },
        { name: "outer/inner/css/a.css", data: "p{}" },
      ]);
      const result = await run(archive);
      if (!result.ok) throw new Error(result.message);
      const stored = openStoredHtmlBundle(result.originalArchive);
      expect(stored.entry).toBe("inner/index.html");
      expect([...stored.files.keys()].sort()).toEqual([
        "inner/css/a.css",
        "inner/index.html",
      ]);
      expect(
        new TextDecoder().decode(stored.files.get("inner/index.html")),
      ).toBe(CLEANED);

      // Re-extract reads the stored archive as stored, and gets the same.
      const again = await runHtmlUploadPipeline({
        archive: result.originalArchive,
        maxExpandedBytes: 1,
        stored: true,
      });
      if (!again.ok) throw new Error(again.message);
      expect(again.templatedTex).toBe(result.templatedTex);
      expect(again.originalArchive).toEqual(result.originalArchive);
    },
    TIMEOUT,
  );

  it(
    "retries with the splice refusal, keeping the LLM's own values for the retry",
    async () => {
      // Ends inside the bold "Kafka", splitting it.
      const splitting = { ...BULLET, value: "Built Kaf" };
      extract
        .mockResolvedValueOnce(selects(splitting))
        .mockResolvedValueOnce(selects(BULLET));
      const result = await run(utf8(PAGE));
      if (!result.ok) throw new Error(result.message);
      expect(result.compileAttempts).toBe(2);
      expect(result.attempts[0]).toMatchObject({
        failureKind: "llm",
        fields: [{ id: BULLET.id, role: "bullet", value: "Built Kaf" }],
      });
      expect(result.attempts[0].failureMessage).toMatch(/formatted element/);
      expect(extract.mock.calls[1][0].previousAttempt).toEqual({
        fields: [splitting],
        failureKind: "splice",
        detail: result.attempts[0].failureMessage,
      });
    },
    TIMEOUT,
  );
});

describe("runHtmlUploadPipeline — rejected", () => {
  it(
    "rejects after the last attempt, and an LLM failure carries no selection forward",
    async () => {
      extract
        .mockRejectedValueOnce(new Error("model down"))
        .mockResolvedValue(selects({ ...BULLET, value: "Spark" }));
      const result = await run(utf8(PAGE), 2);
      expect(result).toMatchObject({ ok: false, stage: "extract-loop" });
      if (result.ok) return;
      expect(result.attempts?.map((a) => a.failureKind)).toEqual([
        "llm",
        "llm",
      ]);
      expect(result.attempts?.[0].failureMessage).toBe("model down");
      expect(extract.mock.calls[1][0].previousAttempt).toBeUndefined();
      expect(result.message).toMatch(/after 2 attempt\(s\)/);
    },
    TIMEOUT,
  );

  it("throws, not a user-facing reject, when a stored archive cannot be opened", async () => {
    await expect(
      runHtmlUploadPipeline({
        archive: buildZip([{ name: "notes.txt", data: "x" }]),
        maxExpandedBytes: 1,
        stored: true,
      }),
    ).rejects.toThrow(
      /^The stored CV archive cannot be opened \(NO_ENTRY\); upload the CV again\.$/,
    );
  });

  it(
    "rejects what cannot be opened or checked as flatten",
    async () => {
      const cases: [Uint8Array, string][] = [
        [utf8("\\documentclass{article}"), "NOT_HTML"],
        [
          utf8(
            '<!doctype html><link rel="stylesheet" href="https://x.test/a.css"><p>x</p>',
          ),
          "REMOTE_REFERENCES",
        ],
        [utf8("<!doctype html><pre>only preformatted</pre>"), "NO_TEXT"],
      ];
      for (const [archive, code] of cases) {
        expect(await run(archive), code).toMatchObject({
          ok: false,
          stage: "flatten",
          flattenCode: code,
        });
      }
      expect(extract).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    "rejects a page Chromium cannot render as compile-original",
    async () => {
      hooks.renderFails = new RenderHtmlPdfError(
        "The page asked for files the upload does not have: x.png",
        "UNANSWERED_REQUESTS",
        ["http://cv.invalid/x.png"],
      );
      expect(await run(utf8(PAGE))).toEqual({
        ok: false,
        stage: "compile-original",
        message:
          "Your CV failed to render to PDF: The page asked for files the upload does not have: x.png",
        originalCompileStderr: "http://cv.invalid/x.png",
      });
      hooks.renderFails = new RenderHtmlPdfError("too slow", "TIMEOUT");
      expect(await run(utf8(PAGE))).toMatchObject({
        stage: "compile-original",
        originalCompileStderr: "too slow",
      });
      expect(extract).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    "retries when the defaults do not give the page back",
    async () => {
      extract.mockResolvedValue(selects(BULLET));
      hooks.templateReply = async () => ({
        templatedHtml: "x",
        defaults: new Map([[BULLET.id, "Built <b>Kafka</b> pipelines"]]),
        insideLinks: [],
        rendered: { ok: true, html: CLEANED.replace("Kafka", "Kafkx") },
      });
      const result = await run(utf8(PAGE));
      if (!result.ok) throw new Error(result.message);
      expect(result.compileAttempts).toBe(2);
      expect(result.attempts[0]).toMatchObject({
        failureKind: "content-diff",
      });
      expect(result.attempts[0].contentDiff).toMatch(
        /^The pages differ at character \d+\.\noriginal: …/,
      );
      // The retry is shown the LLM's own values, not the span markup.
      expect(extract.mock.calls[1][0].previousAttempt).toEqual({
        fields: [BULLET],
        failureKind: "content-diff",
        detail: result.attempts[0].contentDiff,
      });
    },
    TIMEOUT,
  );

  it(
    "retries when the defaults render fails",
    async () => {
      extract.mockResolvedValue(selects(BULLET));
      hooks.templateReply = async () => ({
        templatedHtml: "x",
        defaults: new Map(),
        insideLinks: [],
        rendered: {
          ok: false,
          code: "UNSTABLE_RENDER",
          message: "does not read back",
        },
      });
      const result = await run(utf8(PAGE));
      if (!result.ok) throw new Error(result.message);
      expect(result.attempts[0]).toMatchObject({
        failureKind: "render",
        failureMessage: "does not read back",
      });
      expect(extract.mock.calls[1][0].previousAttempt).toMatchObject({
        failureKind: "render",
      });
    },
    TIMEOUT,
  );

  it(
    "stops at once when the page is over the time or memory budget",
    async () => {
      extract.mockResolvedValue(selects(BULLET));
      hooks.templateReply = () =>
        Promise.reject(new HtmlRejectError("too costly", "CHECK_TOO_COSTLY"));
      const result = await run(utf8(PAGE), 3);
      expect(result).toMatchObject({ ok: false, stage: "extract-loop" });
      if (result.ok) return;
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts?.[0]).toMatchObject({
        failureKind: "render",
        failureMessage: "too costly",
      });
      expect(extract).toHaveBeenCalledTimes(1);
    },
    TIMEOUT,
  );
});
