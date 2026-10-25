// @vitest-environment node
import type { Server } from "node:http";
import {
  ConvertDocxError,
  convertDocxToPdf,
} from "@server/services/cv/docx/convert-docx-pdf";
import {
  type DocxUploadPipelineFailure,
  runDocxUploadPipeline,
} from "@server/services/cv/docx/docx-upload-pipeline";
import { getDocxExtractionPromptDefault } from "@server/services/cv/docx/llm-docx-extract";
import { normalizeStoryPart } from "@server/services/cv/docx/normalize-runs";
import { parseDocx } from "@server/services/cv/docx/parse-docx";
import { spliceMarkers } from "@server/services/cv/docx/splice-markers";
import { simpleDoc } from "@server/services/cv/docx/test/fixture-builder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

// The docx pipeline / extract modules transitively import the LLM stack —
// plain factories keep the real modules unevaluated. convert-docx-pdf is
// stubbed with an error class cv.ts's instanceof checks resolve to.
vi.mock("@server/services/cv/docx/docx-upload-pipeline", () => ({
  runDocxUploadPipeline: vi.fn(),
}));

vi.mock("@server/services/cv/docx/llm-docx-extract", () => ({
  getDocxExtractionPromptDefault: vi.fn(),
}));

vi.mock("@server/services/cv/docx/convert-docx-pdf", () => ({
  convertDocxToPdf: vi.fn(),
  ConvertDocxError: class ConvertDocxError extends Error {
    readonly code: string;
    readonly stderr: string;
    constructor(message: string, code: string, stderr: string) {
      super(message);
      this.name = "ConvertDocxError";
      this.code = code;
      this.stderr = stderr;
    }
  },
}));

const runDocxMock = vi.mocked(runDocxUploadPipeline);
const promptDefaultMock = vi.mocked(getDocxExtractionPromptDefault);
const convertMock = vi.mocked(convertDocxToPdf);

const DOCX_FIXTURE = simpleDoc();
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

// A REAL template envelope over the fixture (parse → normalize → splice),
// so the preview test exercises the real renderDocx against a persisted
// row exactly as production would.
function buildEnvelope(): {
  templatedTex: string;
  defaultFieldValues: Record<string, string>;
} {
  const pkg = parseDocx(DOCX_FIXTURE);
  for (const doc of pkg.storyParts.values()) normalizeStoryPart(doc);
  const parts = spliceMarkers(pkg.storyParts, pkg.storyPartOrder, [
    { id: "basics.headline", value: "Jane Q. Applicant", segmentId: 0 },
  ]);
  return {
    templatedTex: JSON.stringify({ parts: Object.fromEntries(parts) }),
    defaultFieldValues: { "basics.headline": "Jane Q. Applicant" },
  };
}

const ENVELOPE = buildEnvelope();

function docxSuccess() {
  return {
    ok: true as const,
    flattenedTex: "Jane Q. Applicant\nsegment text",
    templatedTex: ENVELOPE.templatedTex,
    fields: [
      {
        id: "basics.headline",
        role: "summary" as const,
        value: "Jane Q. Applicant",
      },
    ],
    defaultFieldValues: ENVELOPE.defaultFieldValues,
    personalBrief: "brief",
    compileStderr: "",
    compileAttempts: 1,
    attempts: [],
  };
}

describe.sequential("CV docx route dispatch", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  async function setDocxProfile(): Promise<void> {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cvSourceFormat: "docx" }),
    });
    expect(res.status).toBe(200);
  }

  function uploadForm(bytes: Uint8Array | string, filename: string): FormData {
    // slice() re-allocates onto a plain ArrayBuffer, satisfying BlobPart's
    // ArrayBuffer (not ArrayBufferLike) constraint.
    const part =
      typeof bytes === "string" ? bytes : (bytes.slice().buffer as ArrayBuffer);
    const form = new FormData();
    form.append("name", "Test CV");
    form.append(
      "file",
      new Blob([part], { type: "application/octet-stream" }),
      filename,
    );
    return form;
  }

  async function uploadTemplate(bytes: Uint8Array | string, filename: string) {
    return fetch(`${baseUrl}/api/cv/upload-template`, {
      method: "POST",
      body: uploadForm(bytes, filename),
    });
  }

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
    vi.clearAllMocks();
    convertMock.mockResolvedValue(PDF_BYTES);
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("422s a docx upload on a latex profile, no pipeline runs", async () => {
    const res = await uploadTemplate(DOCX_FIXTURE, "cv.docx");
    expect(res.status).toBe(422);
    expect(runDocxMock).not.toHaveBeenCalled();
  });

  it("422s a non-docx upload on a docx profile", async () => {
    await setDocxProfile();
    const res = await uploadTemplate("\\documentclass{article}", "cv.tex");
    expect(res.status).toBe(422);
    expect(runDocxMock).not.toHaveBeenCalled();
  });

  it("dispatches a docx upload to the docx pipeline and persists", async () => {
    await setDocxProfile();
    runDocxMock.mockResolvedValue(docxSuccess());

    const res = await uploadTemplate(DOCX_FIXTURE, "cv.docx");
    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      data: { cv: { id: string; templatedTex: string } };
    };
    expect(payload.data.cv.templatedTex).toBe(ENVELOPE.templatedTex);

    expect(runDocxMock).toHaveBeenCalledTimes(1);
    const args = runDocxMock.mock.calls[0][0];
    expect(args.archive).toBeInstanceOf(Uint8Array);
    expect(args.archive.length).toBe(DOCX_FIXTURE.length);
    expect(typeof args.maxExpandedBytes).toBe("number");
  });

  const failureCases: Array<{
    failure: DocxUploadPipelineFailure;
    status: number;
    code: string;
  }> = [
    {
      failure: {
        ok: false,
        stage: "flatten",
        message: "rejected",
        flattenCode: "TRACKED_CHANGES",
      },
      status: 400,
      code: "INVALID_REQUEST",
    },
    {
      failure: {
        ok: false,
        stage: "compile-original",
        message: "rejected",
        originalCompileStderr: "converter said no",
      },
      status: 502,
      code: "UNPROCESSABLE_ENTITY",
    },
    {
      failure: {
        ok: false,
        stage: "extract-loop",
        message: "rejected",
        attempts: [],
      },
      status: 502,
      code: "UPSTREAM_ERROR",
    },
  ];

  for (const testCase of failureCases) {
    const { failure } = testCase;
    const name = `maps a ${failure.stage} reject to ${testCase.status}`;
    it(name, async () => {
      await setDocxProfile();
      runDocxMock.mockResolvedValue(failure);

      const res = await uploadTemplate(DOCX_FIXTURE, "cv.docx");
      expect(res.status).toBe(testCase.status);
      const payload = (await res.json()) as {
        error: { code: string; details: { stage: string } };
      };
      expect(payload.error.code).toBe(testCase.code);
      expect(payload.error.details.stage).toBe(failure.stage);
    });
  }

  it("re-extract-template dispatches to the docx pipeline", async () => {
    await setDocxProfile();
    runDocxMock.mockResolvedValue(docxSuccess());
    const uploadRes = await uploadTemplate(DOCX_FIXTURE, "cv.docx");
    const { data } = (await uploadRes.json()) as {
      data: { cv: { id: string } };
    };

    const res = await fetch(
      `${baseUrl}/api/cv/${data.cv.id}/re-extract-template`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(200);
    expect(runDocxMock).toHaveBeenCalledTimes(2);
  });

  it("serves the docx extraction prompt default", async () => {
    await setDocxProfile();
    promptDefaultMock.mockResolvedValue("docx-default-prompt");

    const res = await fetch(`${baseUrl}/api/cv/extraction-prompt-default`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: { prompt: string } };
    expect(payload.data.prompt).toBe("docx-default-prompt");
  });

  it("renders the docx preview via renderDocx + the converter", async () => {
    await setDocxProfile();
    runDocxMock.mockResolvedValue(docxSuccess());
    const uploadRes = await uploadTemplate(DOCX_FIXTURE, "cv.docx");
    const { data } = (await uploadRes.json()) as {
      data: { cv: { id: string } };
    };

    const res = await fetch(`${baseUrl}/api/cv/${data.cv.id}/render-preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(body.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    // The converter received a real rendered docx, not the raw archive.
    expect(convertMock).toHaveBeenCalledTimes(1);
    expect(convertMock.mock.calls[0][0].docx).toBeInstanceOf(Uint8Array);
  });

  it("serves the original docx preview via the converter", async () => {
    await setDocxProfile();
    runDocxMock.mockResolvedValue(docxSuccess());
    const uploadRes = await uploadTemplate(DOCX_FIXTURE, "cv.docx");
    const { data } = (await uploadRes.json()) as {
      data: { cv: { id: string } };
    };

    const res = await fetch(
      `${baseUrl}/api/cv/${data.cv.id}/render-original-preview`,
    );
    expect(res.status).toBe(200);
    expect(convertMock.mock.calls[0][0].docx.length).toBe(DOCX_FIXTURE.length);
  });

  it("maps a preview converter failure to 422 with stderr", async () => {
    await setDocxProfile();
    runDocxMock.mockResolvedValue(docxSuccess());
    const uploadRes = await uploadTemplate(DOCX_FIXTURE, "cv.docx");
    const { data } = (await uploadRes.json()) as {
      data: { cv: { id: string } };
    };

    convertMock.mockRejectedValueOnce(
      new ConvertDocxError("daemon down", "UNAVAILABLE", "spawn ENOENT"),
    );
    const res = await fetch(`${baseUrl}/api/cv/${data.cv.id}/render-preview`);
    expect(res.status).toBe(422);
    const payload = (await res.json()) as {
      error: { details: { code: string; stderr: string } };
    };
    expect(payload.error.details.code).toBe("UNAVAILABLE");
    expect(payload.error.details.stderr).toBe("spawn ENOENT");
  });
});
