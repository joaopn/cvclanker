// @vitest-environment node

import { createAppSettings } from "@shared/testing/factories";
import type { CvDocument } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// generatePdf on an HTML profile: the real worker substitutes and checks
// values; the repositories, the settings and Chromium are mocked.
vi.mock("@server/repositories/cv-documents", () => ({
  getCvDocumentById: vi.fn(),
  getCvDocumentArchive: vi.fn(),
}));
vi.mock("@server/repositories/job-pdfs", () => ({ upsertJobPdf: vi.fn() }));
vi.mock("@server/services/settings", () => ({ getEffectiveSettings: vi.fn() }));
// Replies for the next per-render worker calls, in call order (undefined:
// the real worker).
const workerReplies = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock("@server/services/cv/html/html-worker", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@server/services/cv/html/html-worker")
    >();
  return {
    ...actual,
    renderHtmlPage: (...args: Parameters<typeof actual.renderHtmlPage>) => {
      const reply = workerReplies.queue.shift();
      return reply ? Promise.resolve(reply) : actual.renderHtmlPage(...args);
    },
  };
});
vi.mock("@server/services/cv/html/render-html-pdf", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@server/services/cv/html/render-html-pdf")
    >();
  return { ...actual, renderHtmlToPdf: vi.fn() };
});

import * as cvRepo from "@server/repositories/cv-documents";
import { upsertJobPdf } from "@server/repositories/job-pdfs";
import { openStoredHtmlBundle } from "@server/services/cv/html/bundle";
import {
  RenderHtmlPdfError,
  renderHtmlToPdf,
} from "@server/services/cv/html/render-html-pdf";
import { buildZip } from "@server/services/cv/html/test/zip-builder";
import { getEffectiveSettings } from "@server/services/settings";
import { generatePdf } from "./pdf";

const PAGE =
  "<!DOCTYPE html><html><head></head><body><p>Built <b>Kafka</b> pipelines</p></body></html>";
const TEMPLATED =
  "<!DOCTYPE html><html><head></head><body><p>⟦b1⟧</p></body></html>";
const DEFAULT = "Built <b>Kafka</b> pipelines";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const TIMEOUT = 60_000;

function cv(
  templatedTex = JSON.stringify({ html: TEMPLATED, insideLinks: [] }),
) {
  return {
    id: "cv-h",
    name: "CV",
    flattenedTex: "Built Kafka pipelines",
    fields: [{ id: "b1", role: "bullet", value: DEFAULT }],
    personalBrief: "",
    templatedTex,
    defaultFieldValues: { b1: DEFAULT },
    lastCompileStderr: null,
    compileAttempts: 1,
    extractionPrompt: "",
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
  } as CvDocument;
}

function stored(archive: Uint8Array, document: CvDocument = cv()) {
  vi.mocked(cvRepo.getCvDocumentById).mockResolvedValue(document);
  vi.mocked(cvRepo.getCvDocumentArchive).mockResolvedValue(
    Buffer.from(archive),
  );
}

function tailor(
  overrides: Record<string, string>,
  allowBaselineRender = false,
) {
  return generatePdf({
    jobId: "job-1",
    cvDocumentId: "cv-h",
    overrides,
    allowBaselineRender,
  });
}

function upserts() {
  return vi
    .mocked(upsertJobPdf)
    .mock.calls.map(([call]) => ({ kind: call.kind, data: call.data }));
}

beforeEach(() => {
  workerReplies.queue = [];
  vi.mocked(getEffectiveSettings).mockResolvedValue(
    createAppSettings({ cvSourceFormat: "html" }),
  );
  vi.mocked(renderHtmlToPdf).mockResolvedValue(PDF);
  stored(new TextEncoder().encode(PAGE));
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("generatePdf — HTML", () => {
  it(
    "renders the tailored page, stores it first and then its PDF",
    async () => {
      const result = await tailor({ b1: "Built <b>Spark</b> jobs" });
      expect(result).toEqual({ success: true, pdfPath: "resume_job-1.pdf" });
      const tailored = PAGE.replace(
        "Built <b>Kafka</b> pipelines",
        "Built <b>Spark</b> jobs",
      );
      const { files, entry } = vi.mocked(renderHtmlToPdf).mock.calls[0][0];
      expect(entry).toBe("index.html");
      expect(Buffer.from(files.get(entry) ?? []).toString()).toBe(tailored);
      expect(upserts().map((u) => u.kind)).toEqual(["resume_html", "resume"]);
      expect(upserts()[0].data.toString()).toBe(tailored);
      expect(new Uint8Array(upserts()[1].data)).toEqual(PDF);
    },
    TIMEOUT,
  );

  it(
    "stores a zip CV's tailored source as a zip, its other files kept",
    async () => {
      stored(
        buildZip([
          { name: "inner/index.html", data: PAGE },
          { name: "inner/a.css", data: "p{}" },
        ]),
      );
      const result = await tailor({ b1: "Built <b>Spark</b> jobs" });
      expect(result.success).toBe(true);
      const source = openStoredHtmlBundle(new Uint8Array(upserts()[0].data));
      expect(source.entry).toBe("inner/index.html");
      expect(
        Buffer.from(source.files.get("inner/a.css") ?? []).toString(),
      ).toBe("p{}");
      expect(
        Buffer.from(source.files.get("inner/index.html") ?? []).toString(),
      ).toContain("Built <b>Spark</b> jobs");
    },
    TIMEOUT,
  );

  it(
    "refuses a tailor that changes nothing, before any PDF render",
    async () => {
      const result = await tailor({ b1: DEFAULT });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no actual change/i);
      expect(renderHtmlToPdf).not.toHaveBeenCalled();
      expect(upsertJobPdf).not.toHaveBeenCalled();
      // A manual render of the baseline is allowed.
      expect((await tailor({ b1: DEFAULT }, true)).success).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "compares with the defaults rendered now, not the page as stored",
    async () => {
      // A page stored by an older build serialises differently from today's
      // render of the same defaults: a no-op tailor is still refused.
      stored(new TextEncoder().encode(`${PAGE}<!-- older build -->`));
      const result = await tailor({ b1: DEFAULT });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no actual change/i);
      expect(renderHtmlToPdf).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    "returns a refused value as a failure, rendering and storing nothing",
    async () => {
      const result = await tailor({ b1: "<i>Kafka</i>" });
      expect(result).toEqual({
        success: false,
        error:
          'Could not render the CV: Field "b1": the value uses <i>, which this CV\'s fields do not use.',
      });
      expect(renderHtmlToPdf).not.toHaveBeenCalled();
      expect(upsertJobPdf).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    "fails, rather than clearing a tailor as a change, when the baseline does not render",
    async () => {
      // The tailored render is real; the baseline (the second call) fails.
      workerReplies.queue = [
        undefined,
        { ok: false, code: "RENDER_TOO_COSTLY", message: "too costly" },
      ];
      expect(await tailor({ b1: DEFAULT })).toEqual({
        success: false,
        error:
          "Could not render the CV with its own values to compare against (RENDER_TOO_COSTLY).",
      });
      expect(renderHtmlToPdf).not.toHaveBeenCalled();
      expect(upsertJobPdf).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it(
    "renders no baseline when the guard cannot fire",
    async () => {
      // The second reply fails: a baseline render would consume it and fail
      // the tailor.
      workerReplies.queue = [
        undefined,
        { ok: false, code: "RENDER_TOO_COSTLY", message: "baseline ran" },
      ];
      expect((await tailor({ b1: DEFAULT }, true)).success).toBe(true);
      expect(workerReplies.queue).toHaveLength(1);
      // Nor with no overrides at all.
      workerReplies.queue = [
        undefined,
        { ok: false, code: "RENDER_TOO_COSTLY", message: "baseline ran" },
      ];
      expect((await tailor({})).success).toBe(true);
      expect(workerReplies.queue).toHaveLength(1);
    },
    TIMEOUT,
  );

  it("returns a tailored render over the budget as a failure", async () => {
    workerReplies.queue = [
      {
        ok: false,
        code: "RENDER_TOO_COSTLY",
        message:
          "The CV is too large or complex to render; shorten the tailored values.",
      },
      { ok: true, html: PAGE },
    ];
    expect(await tailor({ b1: "Built <b>Spark</b> jobs" })).toEqual({
      success: false,
      error:
        "Could not render the CV: The CV is too large or complex to render; shorten the tailored values.",
    });
    expect(upsertJobPdf).not.toHaveBeenCalled();
  });

  it("returns a damaged stored CV as a failure", async () => {
    stored(new TextEncoder().encode(PAGE), cv('{"parts":{}}'));
    expect(await tailor({ b1: "x" })).toEqual({
      success: false,
      error: "The stored CV template cannot be read; upload the CV again.",
    });
    expect(upsertJobPdf).not.toHaveBeenCalled();
  });

  it(
    "returns a Chromium failure as a failure: a count of unanswered requests, otherwise the renderer's first line, as the summary",
    async () => {
      vi.mocked(renderHtmlToPdf).mockRejectedValue(
        new RenderHtmlPdfError("missing x.png", "UNANSWERED_REQUESTS", [
          "http://cv.invalid/x.png",
          "http://cv.invalid/y.png",
          "http://cv.invalid/x.png",
        ]),
      );
      const result = await tailor({ b1: "Built <b>Spark</b> jobs" });
      expect(result).toEqual({
        success: false,
        error:
          "PDF render failed (UNANSWERED_REQUESTS): the page asked for 2 file(s) the CV does not contain.\n\nRequests the CV could not answer (2):\n  http://cv.invalid/x.png\n  http://cv.invalid/y.png",
      });
      // Only a restarted browser is retried.
      expect(renderHtmlToPdf).toHaveBeenCalledTimes(1);
      expect(upsertJobPdf).not.toHaveBeenCalled();

      // A multi-line message (a browser log) keeps its first line as the
      // summary and the rest as the detail.
      vi.mocked(renderHtmlToPdf).mockRejectedValue(
        new RenderHtmlPdfError(
          "HTML render failed: boom\nCall log:\n  - navigating",
          "RENDER_FAILED",
        ),
      );
      expect((await tailor({ b1: "Built <b>Spark</b> jobs" })).error).toBe(
        "PDF render failed (RENDER_FAILED): HTML render failed: boom\n\nCall log:\n  - navigating",
      );

      // An empty first line leaves no dangling colon.
      vi.mocked(renderHtmlToPdf).mockRejectedValue(
        new RenderHtmlPdfError("\nlog only", "RENDER_FAILED"),
      );
      expect((await tailor({ b1: "Built <b>Spark</b> jobs" })).error).toBe(
        "PDF render failed (RENDER_FAILED).\n\nlog only",
      );
    },
    TIMEOUT,
  );

  it(
    "retries once when the shared browser restarted under the render",
    async () => {
      const restarted = new RenderHtmlPdfError("stopped", "UNAVAILABLE");
      vi.mocked(renderHtmlToPdf)
        .mockRejectedValueOnce(restarted)
        .mockResolvedValueOnce(PDF);
      expect((await tailor({ b1: "Built <b>Spark</b> jobs" })).success).toBe(
        true,
      );
      expect(renderHtmlToPdf).toHaveBeenCalledTimes(2);

      vi.mocked(renderHtmlToPdf).mockReset();
      vi.mocked(renderHtmlToPdf).mockRejectedValue(restarted);
      expect((await tailor({ b1: "Built <b>Spark</b> jobs" })).success).toBe(
        false,
      );
      expect(renderHtmlToPdf).toHaveBeenCalledTimes(2);
    },
    TIMEOUT,
  );
});
