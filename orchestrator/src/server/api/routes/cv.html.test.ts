// @vitest-environment node
import type { Server } from "node:http";
import { runHtmlUploadPipeline } from "@server/services/cv/html/html-upload-pipeline";
import { getHtmlExtractionPromptDefault } from "@server/services/cv/html/llm-html-extract";
import {
  RenderHtmlPdfError,
  renderHtmlToPdf,
} from "@server/services/cv/html/render-html-pdf";
import { StoredHtmlCvError } from "@server/services/cv/html/stored-html-cv";
import { buildZip } from "@server/services/cv/html/test/zip-builder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

// The HTML arms of the CV routes. The pipeline and Chromium are mocked; the
// stored-CV reading and the per-render substitution (the worker) are real.
vi.mock("@server/services/cv/html/html-upload-pipeline", () => ({
  runHtmlUploadPipeline: vi.fn(),
}));
vi.mock("@server/services/cv/html/llm-html-extract", () => ({
  getHtmlExtractionPromptDefault: vi.fn(),
}));
vi.mock("@server/services/cv/html/render-html-pdf", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@server/services/cv/html/render-html-pdf")
    >();
  return { ...actual, renderHtmlToPdf: vi.fn() };
});

// Set to replace the next per-render result (the real worker otherwise).
const workerReply = vi.hoisted(() => ({ next: undefined as unknown }));
vi.mock("@server/services/cv/html/html-worker", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@server/services/cv/html/html-worker")
    >();
  return {
    ...actual,
    renderHtmlPage: (...args: Parameters<typeof actual.renderHtmlPage>) => {
      const reply = workerReply.next;
      workerReply.next = undefined;
      return reply ? Promise.resolve(reply) : actual.renderHtmlPage(...args);
    },
  };
});

const pipeline = vi.mocked(runHtmlUploadPipeline);
const promptDefault = vi.mocked(getHtmlExtractionPromptDefault);
const renderPdf = vi.mocked(renderHtmlToPdf);

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const PAGE =
  "<!DOCTYPE html><html><head></head><body><p>Jane Doe</p></body></html>";
const TEMPLATED =
  "<!DOCTYPE html><html><head></head><body><p>⟦name.0⟧</p></body></html>";
const CLEANED = new TextEncoder().encode(PAGE);
const TIMEOUT = 60_000;

function accepted() {
  return {
    ok: true as const,
    flattenedTex: "Jane Doe",
    templatedTex: JSON.stringify({ html: TEMPLATED, insideLinks: [] }),
    fields: [{ id: "name.0", role: "other" as const, value: "Jane Doe" }],
    defaultFieldValues: { "name.0": "Jane Doe" },
    personalBrief: "brief",
    compileStderr: "",
    compileAttempts: 1,
    attempts: [],
    originalArchive: CLEANED,
  };
}

describe.sequential("CV routes — HTML profile", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  async function useHtmlProfile(): Promise<void> {
    const settingsRepo = await import("@server/repositories/settings");
    await settingsRepo.setSetting("cvSourceFormat", "html");
  }

  async function storedCv(overrides: {
    archive?: Uint8Array;
    templatedTex?: string;
    defaults?: Record<string, string>;
  }): Promise<string> {
    const cvRepo = await import("@server/repositories/cv-documents");
    const cv = await cvRepo.createCvDocument({
      name: "CV",
      originalArchive: overrides.archive ?? CLEANED,
      flattenedTex: "Jane Doe",
      fields: [],
      personalBrief: "",
      templatedTex:
        overrides.templatedTex ??
        JSON.stringify({ html: TEMPLATED, insideLinks: [] }),
      defaultFieldValues: overrides.defaults ?? { "name.0": "Jane Doe" },
    });
    return cv.id;
  }

  async function storedArchive(id: string): Promise<string> {
    const cvRepo = await import("@server/repositories/cv-documents");
    const archive = await cvRepo.getCvDocumentArchive(id);
    return Buffer.from(archive ?? []).toString();
  }

  function upload(bytes: Uint8Array | string, filename: string) {
    const part =
      typeof bytes === "string" ? bytes : (bytes.slice().buffer as ArrayBuffer);
    const form = new FormData();
    form.append("file", new Blob([part]), filename);
    return fetch(`${baseUrl}/api/cv/upload-template`, {
      method: "POST",
      body: form,
    });
  }

  async function errorOf(res: Response) {
    return (
      (await res.json()) as {
        error: { code: string; message: string; details?: unknown };
      }
    ).error;
  }

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
    vi.clearAllMocks();
    pipeline.mockReset();
    workerReply.next = undefined;
    renderPdf.mockReset();
    renderPdf.mockResolvedValue(PDF);
    await useHtmlProfile();
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("runs a page through the pipeline and stores the cleaned bundle", async () => {
    pipeline.mockResolvedValue(accepted());
    const uploaded = `${PAGE}<!-- as uploaded -->`;
    const res = await upload(uploaded, "cv.html");
    expect(res.status).toBe(201);
    expect(pipeline).toHaveBeenCalledWith({
      archive: new TextEncoder().encode(uploaded),
      maxRetries: undefined,
      extractionPrompt: undefined,
      maxExpandedBytes: expect.any(Number),
    });
    const { data } = (await res.json()) as {
      data: { cv: { id: string; name: string } };
    };
    expect(data.cv.name).toBe("cv");
    expect(await storedArchive(data.cv.id)).toBe(PAGE);
  });

  it("passes any zip but a Word document on to the pipeline", async () => {
    pipeline.mockResolvedValue(accepted());
    const res = await upload(
      buildZip([{ name: "site/index.html", data: PAGE }]),
      "cv.zip",
    );
    expect(res.status).toBe(201);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("reports a pipeline reject as the other formats do", async () => {
    pipeline.mockResolvedValue({
      ok: false,
      stage: "flatten",
      message: "The page loads files from the internet.",
      flattenCode: "REMOTE_REFERENCES",
    });
    const res = await upload(PAGE, "cv.html");
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({
      code: "INVALID_REQUEST",
      message: "The page loads files from the internet.",
      details: { stage: "flatten", flattenCode: "REMOTE_REFERENCES" },
    });
  });

  it("serves the HTML extraction prompt default", async () => {
    promptDefault.mockResolvedValue("html-default-prompt");
    const res = await fetch(`${baseUrl}/api/cv/extraction-prompt-default`);
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { data: { prompt: string } }).data.prompt,
    ).toBe("html-default-prompt");
  });

  it(
    "renders the template with its defaults for the preview",
    async () => {
      const id = await storedCv({ defaults: { "name.0": "Jane <b>Doe</b>" } });
      // A default may hold markup the defaults use.
      const res = await fetch(`${baseUrl}/api/cv/${id}/render-preview`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/pdf");
      expect(renderPdf).toHaveBeenCalledTimes(1);
      const { files, entry } = renderPdf.mock.calls[0][0];
      expect(entry).toBe("index.html");
      expect(Buffer.from(files.get(entry) ?? []).toString()).toBe(
        PAGE.replace("Jane Doe", "Jane <b>Doe</b>"),
      );
    },
    TIMEOUT,
  );

  it(
    "renders a stored zip's own entry and files as packed",
    async () => {
      const archive = buildZip([
        { name: "inner/index.html", data: TEMPLATED },
        { name: "inner/a.css", data: "p{}" },
      ]);
      const id = await storedCv({ archive });
      await fetch(`${baseUrl}/api/cv/${id}/render-preview`);
      const { files, entry } = renderPdf.mock.calls[0][0];
      expect(entry).toBe("inner/index.html");
      expect([...files.keys()].sort()).toEqual([
        "inner/a.css",
        "inner/index.html",
      ]);

      await fetch(`${baseUrl}/api/cv/${id}/render-original-preview`);
      const original = renderPdf.mock.calls[1][0];
      expect(original.entry).toBe("inner/index.html");
      expect(
        Buffer.from(original.files.get(original.entry) ?? []).toString(),
      ).toBe(TEMPLATED);
    },
    TIMEOUT,
  );

  it(
    "answers stored defaults that no longer render with 500",
    async () => {
      const id = await storedCv({ defaults: { "name.0": '<img src="x">' } });
      const res = await fetch(`${baseUrl}/api/cv/${id}/render-preview`);
      expect(res.status).toBe(500);
      expect((await errorOf(res)).message).toBe(
        "The stored CV does not render with its own values (VALUE_NOT_ALLOWED); re-extract the CV, or upload it again.",
      );
      expect(renderPdf).not.toHaveBeenCalled();
    },
    TIMEOUT,
  );

  it("answers a preview over the render budget with 422, without blaming tailored values", async () => {
    workerReply.next = {
      ok: false,
      code: "RENDER_TOO_COSTLY",
      message:
        "The CV is too large or complex to render; shorten the tailored values.",
    };
    const id = await storedCv({});
    const res = await fetch(`${baseUrl}/api/cv/${id}/render-preview`);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      message: "The CV is too large or complex to render.",
      details: { code: "RENDER_TOO_COSTLY" },
    });
  });

  it("answers a preview past the page caps with 422, as a too-costly one", async () => {
    workerReply.next = {
      ok: false,
      code: "PAGE_TOO_COMPLEX",
      message:
        "The rendered CV has more than 10000 elements; shorten the tailored values.",
    };
    const id = await storedCv({});
    const res = await fetch(`${baseUrl}/api/cv/${id}/render-preview`);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      message: "The CV is too large or complex to render.",
      details: { code: "PAGE_TOO_COMPLEX" },
    });
  });

  it("answers a failed render worker with 500, not as the CV's fault", async () => {
    workerReply.next = {
      ok: false,
      code: "RENDER_WORKER_FAILED",
      message: "The CV could not be rendered because of an internal error.",
    };
    const id = await storedCv({});
    const res = await fetch(`${baseUrl}/api/cv/${id}/render-preview`);
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toMatchObject({
      message: "The CV could not be rendered because of an internal error.",
      details: { code: "RENDER_WORKER_FAILED" },
    });
  });

  it("answers a renderer failure with 422 and the unanswered requests", async () => {
    renderPdf.mockRejectedValue(
      new RenderHtmlPdfError("missing x.png", "UNANSWERED_REQUESTS", [
        "http://cv.invalid/x.png",
      ]),
    );
    const id = await storedCv({});
    const res = await fetch(`${baseUrl}/api/cv/${id}/render-original-preview`);
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({
      message: "missing x.png",
      details: {
        code: "UNANSWERED_REQUESTS",
        unansweredRequests: ["http://cv.invalid/x.png"],
      },
    });
  });

  it("answers a damaged stored CV with 500 and asks for a re-upload", async () => {
    const badEnvelope = await storedCv({ templatedTex: '{"parts":{}}' });
    const res = await fetch(`${baseUrl}/api/cv/${badEnvelope}/render-preview`);
    expect(res.status).toBe(500);
    expect((await errorOf(res)).message).toBe(
      "The stored CV template cannot be read; upload the CV again.",
    );

    const badArchive = await storedCv({
      archive: buildZip([{ name: "x.txt", data: "x" }]),
    });
    const original = await fetch(
      `${baseUrl}/api/cv/${badArchive}/render-original-preview`,
    );
    expect(original.status).toBe(500);
    expect((await errorOf(original)).message).toBe(
      "The stored CV archive cannot be opened (NO_ENTRY); upload the CV again.",
    );
  });

  it("re-extracts from the stored archive as stored, and stores the result", async () => {
    const id = await storedCv({ archive: new TextEncoder().encode(TEMPLATED) });
    pipeline.mockResolvedValue(accepted());
    const res = await fetch(`${baseUrl}/api/cv/${id}/re-extract-template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(pipeline).toHaveBeenCalledWith({
      archive: new TextEncoder().encode(TEMPLATED),
      maxRetries: undefined,
      extractionPrompt: undefined,
      maxExpandedBytes: expect.any(Number),
      stored: true,
    });
    expect(await storedArchive(id)).toBe(PAGE);
  });

  it("answers a stored archive the pipeline cannot open with 500", async () => {
    const id = await storedCv({});
    pipeline.mockRejectedValue(
      new StoredHtmlCvError(
        "The stored CV archive cannot be opened (NO_ENTRY); upload the CV again.",
      ),
    );
    const res = await fetch(`${baseUrl}/api/cv/${id}/re-extract-template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(500);
    expect((await errorOf(res)).message).toMatch(/^The stored CV archive/);
  });
});
