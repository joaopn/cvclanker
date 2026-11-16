import { describe, expect, it } from "vitest";
import { cvDownloadTarget } from "./cv-download";

const job = { id: "job-1", updatedAt: "2026-11-16T10:00:00Z" };
const v = "?v=2026-11-16T10%3A00%3A00Z";

describe("cvDownloadTarget", () => {
  it("hands over the PDF on a LaTeX profile", () => {
    expect(cvDownloadTarget("latex", job)).toEqual({
      href: `/pdfs/resume_job-1.pdf${v}`,
      ext: "pdf",
    });
  });

  it("hands over the tailored .docx on a Word profile", () => {
    expect(cvDownloadTarget("docx", job)).toEqual({
      href: `/pdfs/resume_job-1.docx${v}`,
      ext: "docx",
    });
  });

  it("hands over the PDF on an HTML profile until the tailored page is served", () => {
    expect(cvDownloadTarget("html", job)).toEqual({
      href: `/pdfs/resume_job-1.pdf${v}`,
      ext: "pdf",
    });
  });

  it("hands over the PDF for a format this build does not know", () => {
    expect(cvDownloadTarget("bogus" as never, job)).toEqual({
      href: `/pdfs/resume_job-1.pdf${v}`,
      ext: "pdf",
    });
  });
});
