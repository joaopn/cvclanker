// @vitest-environment node
import { composeTailoringFailure } from "@shared/tailoring-failure";
import { createJob } from "@shared/testing/factories";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getJobById: vi.fn(),
  updateJob: vi.fn(),
  getActiveCvDocument: vi.fn(),
  generatePdf: vi.fn(),
}));

vi.mock("@server/repositories/jobs", () => ({
  getJobById: (...args: unknown[]) => mocks.getJobById(...args),
  updateJob: (...args: unknown[]) => mocks.updateJob(...args),
}));

vi.mock("@server/services/cv-active", () => ({
  getActiveCvDocument: (...args: unknown[]) => mocks.getActiveCvDocument(...args),
}));

vi.mock("@server/services/pdf", () => ({
  generatePdf: (...args: unknown[]) => mocks.generatePdf(...args),
}));

vi.mock("@infra/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { renderCvPdf } from "./render-cv";

beforeEach(() => {
  mocks.getJobById.mockReset();
  mocks.updateJob.mockReset();
  mocks.getActiveCvDocument.mockReset();
  mocks.generatePdf.mockReset();
});

describe("renderCvPdf", () => {
  it("renders against pinned CV doc, persists pdfPath, returns reloaded job", async () => {
    const job = createJob({
      id: "job-render",
      cvDocumentId: "cv-pinned",
      tailoredFields: { "experience.0.bullet.0": "Edited bullet" },
    });
    const expectedPdfPath = "resume_job-render.pdf";
    mocks.getJobById
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({ ...job, pdfPath: expectedPdfPath });
    mocks.generatePdf.mockResolvedValue({
      success: true,
      pdfPath: expectedPdfPath,
    });

    const result = await renderCvPdf({ jobId: "job-render" });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(mocks.getActiveCvDocument).not.toHaveBeenCalled();
    expect(mocks.generatePdf).toHaveBeenCalledWith({
      jobId: "job-render",
      cvDocumentId: "cv-pinned",
      overrides: { "experience.0.bullet.0": "Edited bullet" },
      allowBaselineRender: true,
    });
    expect(mocks.updateJob).toHaveBeenCalledWith("job-render", {
      pdfPath: expectedPdfPath,
    });
    expect(result.pdfPath).toBe(expectedPdfPath);
  });

  it("falls back to active CV doc when job is unpinned, then pins it", async () => {
    const job = createJob({
      id: "job-fallback",
      cvDocumentId: null,
      tailoredFields: {},
    });
    const expectedPdfPath = "resume_job-fallback.pdf";
    mocks.getJobById
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({
        ...job,
        cvDocumentId: "cv-active",
        pdfPath: expectedPdfPath,
      });
    mocks.getActiveCvDocument.mockResolvedValue({ id: "cv-active" });
    mocks.generatePdf.mockResolvedValue({
      success: true,
      pdfPath: expectedPdfPath,
    });

    const result = await renderCvPdf({ jobId: "job-fallback" });

    expect(result.success).toBe(true);
    expect(mocks.generatePdf).toHaveBeenCalledWith(
      expect.objectContaining({ cvDocumentId: "cv-active" }),
    );
    expect(mocks.updateJob).toHaveBeenCalledWith("job-fallback", {
      cvDocumentId: "cv-active",
      pdfPath: expectedPdfPath,
    });
  });

  it("rejects when no CV doc is available", async () => {
    mocks.getJobById.mockResolvedValueOnce(
      createJob({ id: "job-nocv", cvDocumentId: null }),
    );
    mocks.getActiveCvDocument.mockResolvedValue(null);

    const result = await renderCvPdf({ jobId: "job-nocv" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/no cv uploaded/i);
    expect(mocks.generatePdf).not.toHaveBeenCalled();
  });

  it("rejects when the job does not exist", async () => {
    mocks.getJobById.mockResolvedValueOnce(null);

    const result = await renderCvPdf({ jobId: "missing" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/job not found/i);
    expect(mocks.generatePdf).not.toHaveBeenCalled();
  });

  it("surfaces generatePdf failures without persisting pdfPath", async () => {
    const job = createJob({
      id: "job-fail",
      cvDocumentId: "cv-1",
      tailoredFields: {},
    });
    mocks.getJobById.mockResolvedValueOnce(job);
    mocks.generatePdf.mockResolvedValue({
      success: false,
      error: "LaTeX compile failed: missing closing brace",
    });

    const result = await renderCvPdf({ jobId: "job-fail" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toMatch(/latex compile failed/i);
    expect(mocks.updateJob).not.toHaveBeenCalled();
  });

  it("returns the summary alone when generatePdf carries a detail block", async () => {
    // This error reaches a toast. The detail is logged instead, since nothing
    // on the Render path persists a reason.
    const job = createJob({
      id: "job-detail",
      cvDocumentId: "cv-1",
      tailoredFields: {},
    });
    mocks.getJobById.mockResolvedValueOnce(job);
    mocks.generatePdf.mockResolvedValue({
      success: false,
      error: composeTailoringFailure(
        "LaTeX compile failed: missing closing brace",
        "! Undefined control sequence.\nl.42 \\badmacro",
      ),
    });

    const result = await renderCvPdf({ jobId: "job-detail" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("LaTeX compile failed: missing closing brace");
    expect(result.error).not.toContain("Undefined control sequence");
  });

  it("passes allowBaselineRender=true so a no-override compile is allowed", async () => {
    const job = createJob({
      id: "job-baseline",
      cvDocumentId: "cv-baseline",
      tailoredFields: {},
    });
    mocks.getJobById
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({ ...job, pdfPath: "/p" });
    mocks.generatePdf.mockResolvedValue({
      success: true,
      pdfPath: "/p",
    });

    await renderCvPdf({ jobId: "job-baseline" });

    expect(mocks.generatePdf).toHaveBeenCalledWith(
      expect.objectContaining({ allowBaselineRender: true }),
    );
  });
});
