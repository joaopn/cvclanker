// @vitest-environment node
import type { Server } from "node:http";
import { simpleDoc } from "@server/services/cv/docx/test/fixture-builder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

// Every format branch of the CV routes: the upload's format check, the HTML
// arms (refused until HTML CVs are wired in) and the arm for a stored format
// this build does not know.

// The pipelines transitively import the LLM stack, and none may run here.
vi.mock("@server/services/cv/docx/docx-upload-pipeline", () => ({
  runDocxUploadPipeline: vi.fn(),
}));
vi.mock("@server/services/cv/upload-pipeline", () => ({
  runUploadPipeline: vi.fn(),
}));

const HTML_PAGE = "<!doctype html><html><body><p>Jane Doe</p></body></html>";

describe.sequential("CV route format branches", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  // Written straight to the settings table: the settings PATCH validates the
  // value and guards it, and these tests need values it would refuse.
  async function storeFormat(value: string): Promise<void> {
    const settingsRepo = await import("@server/repositories/settings");
    await settingsRepo.setSetting("cvSourceFormat", value);
  }

  async function createCv(): Promise<string> {
    const cvRepo = await import("@server/repositories/cv-documents");
    const cv = await cvRepo.createCvDocument({
      name: "CV",
      originalArchive: new TextEncoder().encode(HTML_PAGE),
      flattenedTex: "Jane Doe",
      fields: [],
      personalBrief: "",
      templatedTex: "x",
      defaultFieldValues: {},
    });
    return cv.id;
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

  async function messageOf(res: Response): Promise<string> {
    return ((await res.json()) as { error: { message: string } }).error.message;
  }

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("refuses a Word document or an HTML page on a LaTeX profile, naming it", async () => {
    const word = await upload(simpleDoc(), "cv.docx");
    expect(word.status).toBe(422);
    expect(await messageOf(word)).toBe(
      "This profile uses LaTeX CVs and this is a Word document; to work with another format, create a user profile for it.",
    );
    const page = await upload(HTML_PAGE, "cv.html");
    expect(page.status).toBe(422);
    expect(await messageOf(page)).toBe(
      "This profile uses LaTeX CVs and this is an HTML page; to work with another format, create a user profile for it.",
    );
  });

  it("refuses anything but a Word document on a Word profile", async () => {
    await storeFormat("docx");
    const res = await upload("\\documentclass{article}", "cv.tex");
    expect(res.status).toBe(422);
    expect(await messageOf(res)).toBe(
      "This profile uses Word CVs and this is not a .docx file, or is a password-protected one. Save it as an unprotected .docx (an older .doc will not do), or create a user profile for another format.",
    );
  });

  async function answers(format: string) {
    await storeFormat(format);
    const id = await createCv();
    const requests: [string, () => Promise<Response>][] = [
      ["upload", () => upload(HTML_PAGE, "cv.html")],
      [
        "extraction-prompt-default",
        () => fetch(`${baseUrl}/api/cv/extraction-prompt-default`),
      ],
      ["render-preview", () => fetch(`${baseUrl}/api/cv/${id}/render-preview`)],
      [
        "render-original-preview",
        () => fetch(`${baseUrl}/api/cv/${id}/render-original-preview`),
      ],
      [
        "re-extract-template",
        () =>
          fetch(`${baseUrl}/api/cv/${id}/re-extract-template`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
      ],
    ];
    const results: Record<string, [number, string]> = {};
    for (const [name, request] of requests) {
      const res = await request();
      results[name] = [res.status, await messageOf(res)];
    }
    return results;
  }

  it("refuses every HTML arm until HTML CVs are wired in", async () => {
    const refused: [number, string] = [
      422,
      "HTML CVs cannot be uploaded or rendered yet.",
    ];
    expect(await answers("html")).toEqual({
      upload: refused,
      "extraction-prompt-default": refused,
      "render-preview": refused,
      "render-original-preview": refused,
      "re-extract-template": refused,
    });
  });

  it("refuses a stored format this build does not know", async () => {
    const refused: [number, string] = [422, "Unknown CV format."];
    expect(await answers("bogus")).toEqual({
      upload: refused,
      "extraction-prompt-default": refused,
      "render-preview": refused,
      "render-original-preview": refused,
      "re-extract-template": refused,
    });
  });

  it("refuses a template edit on every profile but LaTeX", async () => {
    for (const format of ["docx", "html", "bogus"]) {
      await storeFormat(format);
      const id = await createCv();
      const res = await fetch(`${baseUrl}/api/cv/${id}/template`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templatedTex: "x" }),
      });
      expect(res.status, format).toBe(422);
      expect(await messageOf(res), format).toBe(
        "Only LaTeX CV templates can be edited.",
      );
    }
  });
});
