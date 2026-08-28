// @vitest-environment node
import { createCoverLetterDocument, createJob } from "@shared/testing/factories";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runTectonic: vi.fn(),
  renderTemplate: vi.fn(),
  getJobById: vi.fn(),
  updateJob: vi.fn(),
  listCoverLetterDocuments: vi.fn(),
  getCoverLetterDocumentById: vi.fn(),
  getCoverLetterDocumentArchive: vi.fn(),
  upsertJobPdf: vi.fn(),
}));

vi.mock("@server/services/cv/run-tectonic", async (importActual) => {
  const actual =
    await importActual<typeof import("@server/services/cv/run-tectonic")>();
  return { ...actual, runTectonic: mocks.runTectonic };
});

vi.mock("@server/services/cv/render-template", async (importActual) => {
  const actual =
    await importActual<typeof import("@server/services/cv/render-template")>();
  return { ...actual, renderTemplate: mocks.renderTemplate };
});

vi.mock("@server/repositories/jobs", () => ({
  getJobById: (...args: unknown[]) => mocks.getJobById(...args),
  updateJob: (...args: unknown[]) => mocks.updateJob(...args),
}));

vi.mock("@server/repositories/cover-letter-documents", () => ({
  listCoverLetterDocuments: (...args: unknown[]) =>
    mocks.listCoverLetterDocuments(...args),
  getCoverLetterDocumentById: (...args: unknown[]) =>
    mocks.getCoverLetterDocumentById(...args),
  getCoverLetterDocumentArchive: (...args: unknown[]) =>
    mocks.getCoverLetterDocumentArchive(...args),
}));

vi.mock("@server/repositories/job-pdfs", () => ({
  upsertJobPdf: (...args: unknown[]) => mocks.upsertJobPdf(...args),
}));

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { renderCoverLetterPdf } from "./render";

beforeEach(() => {
  mocks.runTectonic.mockReset();
  mocks.renderTemplate.mockReset();
  mocks.getJobById.mockReset();
  mocks.updateJob.mockReset();
  mocks.listCoverLetterDocuments.mockReset();
  mocks.getCoverLetterDocumentById.mockReset();
  mocks.getCoverLetterDocumentArchive.mockReset();
  mocks.upsertJobPdf.mockReset();
});

describe("renderCoverLetterPdf", () => {
  it("merges defaults with overrides (overrides win), stores the PDF blob, persists path, pins doc", async () => {
    const job = createJob({
      id: "job-render",
      coverLetterDocumentId: null,
      coverLetterFieldOverrides: { "body.text": "Override body" },
    });
    const doc = createCoverLetterDocument({
      id: "cl-render",
      templatedTex: "\\begin{letter}{Acme}«body.text»«recipient»\\end{letter}",
      defaultFieldValues: {
        "body.text": "Default body",
        recipient: "Hiring Team",
      },
      fields: [
        { id: "body.text", role: "body", value: "Default body" },
        { id: "recipient", role: "name", value: "Hiring Team" },
      ],
    });
    mocks.getJobById
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({
        ...job,
        coverLetterDocumentId: "cl-render",
        coverLetterPdfPath: "cover_letter_job-render.pdf",
      });
    mocks.listCoverLetterDocuments.mockResolvedValue([{ id: "cl-render" }]);
    mocks.getCoverLetterDocumentById.mockResolvedValue(doc);
    mocks.getCoverLetterDocumentArchive.mockResolvedValue(Buffer.from("PK"));
    mocks.renderTemplate.mockReturnValue("rendered tex");
    mocks.runTectonic.mockResolvedValue({
      pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      log: "ok",
    });

    const result = await renderCoverLetterPdf({ jobId: "job-render" });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(mocks.renderTemplate).toHaveBeenCalledWith(doc.templatedTex, {
      "body.text": "Override body",
      recipient: "Hiring Team",
    });

    expect(result.pdfPath).toBe("cover_letter_job-render.pdf");
    expect(mocks.upsertJobPdf).toHaveBeenCalledWith({
      jobId: "job-render",
      kind: "cover_letter",
      data: Buffer.from([0x25, 0x50, 0x44, 0x46]),
    });

    expect(mocks.updateJob).toHaveBeenCalledWith("job-render", {
      coverLetterDocumentId: "cl-render",
      coverLetterPdfPath: "cover_letter_job-render.pdf",
    });
  });

  it("renders an EMPTY body for a job that was never generated, keeping every other default", async () => {
    const job = createJob({
      id: "job-fresh",
      coverLetterDocumentId: null,
      coverLetterFieldOverrides: {},
    });
    const doc = createCoverLetterDocument({
      id: "cl-fresh",
      templatedTex: "\\begin{letter}{Acme}«body.text»«recipient»\\end{letter}",
      defaultFieldValues: {
        "body.text": "Dear Other Company, I have long admired…",
        recipient: "Hiring Team",
      },
      fields: [
        {
          id: "body.text",
          role: "body",
          value: "Dear Other Company, I have long admired…",
        },
        { id: "recipient", role: "name", value: "Hiring Team" },
      ],
    });
    mocks.getJobById.mockResolvedValueOnce(job).mockResolvedValueOnce({
      ...job,
      coverLetterDocumentId: "cl-fresh",
      coverLetterPdfPath: "cover_letter_job-fresh.pdf",
    });
    mocks.listCoverLetterDocuments.mockResolvedValue([{ id: "cl-fresh" }]);
    mocks.getCoverLetterDocumentById.mockResolvedValue(doc);
    mocks.getCoverLetterDocumentArchive.mockResolvedValue(Buffer.from("PK"));
    mocks.renderTemplate.mockReturnValue("rendered tex");
    mocks.runTectonic.mockResolvedValue({
      pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      log: "ok",
    });

    const result = await renderCoverLetterPdf({ jobId: "job-fresh" });

    expect(result.success).toBe(true);
    // The uploaded letter's prose belongs to whatever application it was
    // written for — it must never reach this job's PDF.
    expect(mocks.renderTemplate).toHaveBeenCalledWith(doc.templatedTex, {
      "body.text": "",
      recipient: "Hiring Team",
    });
  });

  it("rejects when no cover-letter doc has been uploaded", async () => {
    mocks.getJobById.mockResolvedValueOnce(createJob({ id: "job-1" }));
    mocks.listCoverLetterDocuments.mockResolvedValue([]);

    const result = await renderCoverLetterPdf({ jobId: "job-1" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/no cover-letter template/i);
    expect(mocks.runTectonic).not.toHaveBeenCalled();
  });

  it("falls back to most-recently-updated cover-letter doc when job not pinned", async () => {
    const job = createJob({ id: "job-2", coverLetterDocumentId: null });
    const doc = createCoverLetterDocument({
      id: "fallback-doc",
      templatedTex: "X«body.text»",
      fields: [{ id: "body.text", role: "body", value: "x" }],
      defaultFieldValues: { "body.text": "x" },
    });
    mocks.getJobById
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({ ...job, coverLetterDocumentId: "fallback-doc" });
    mocks.listCoverLetterDocuments.mockResolvedValue([{ id: "fallback-doc" }]);
    mocks.getCoverLetterDocumentById.mockResolvedValue(doc);
    mocks.getCoverLetterDocumentArchive.mockResolvedValue(Buffer.from("PK"));
    mocks.renderTemplate.mockReturnValue("rendered tex");
    mocks.runTectonic.mockResolvedValue({
      pdf: new Uint8Array([0x25]),
      log: "",
    });

    const result = await renderCoverLetterPdf({ jobId: "job-2" });
    expect(result.success).toBe(true);
    expect(mocks.getCoverLetterDocumentById).toHaveBeenCalledWith(
      "fallback-doc",
    );
  });

  it("rejects when the cover-letter doc has no templated tex", async () => {
    mocks.getJobById.mockResolvedValueOnce(
      createJob({ id: "job-3", coverLetterDocumentId: "doc-empty" }),
    );
    mocks.getCoverLetterDocumentById.mockResolvedValue(
      createCoverLetterDocument({ id: "doc-empty", templatedTex: "" }),
    );

    const result = await renderCoverLetterPdf({ jobId: "job-3" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/no templated tex/i);
    expect(mocks.upsertJobPdf).not.toHaveBeenCalled();
  });
});
