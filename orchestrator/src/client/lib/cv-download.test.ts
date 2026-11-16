import { describe, expect, it } from "vitest";
import { cvDownloadTarget } from "./cv-download";

const job = { id: "job-1", updatedAt: "2026-11-16T10:00:00Z" };
const v = "?v=2026-11-16T10%3A00%3A00Z";
const target = (ext: string) => ({
  href: `/pdfs/resume_job-1.${ext}${v}`,
  ext,
});

describe("cvDownloadTarget", () => {
  it("hands over the PDF on a LaTeX profile", () => {
    expect(cvDownloadTarget("latex", job)).toEqual(target("pdf"));
  });

  it("hands over the tailored .docx on a Word profile", () => {
    expect(cvDownloadTarget("docx", job)).toEqual(target("docx"));
  });

  it("hands over an HTML CV's tailored source in the shape it was uploaded", () => {
    expect(
      cvDownloadTarget("html", { ...job, tailoredSourceShape: "file" }),
    ).toEqual(target("html"));
    expect(
      cvDownloadTarget("html", { ...job, tailoredSourceShape: "bundle" }),
    ).toEqual(target("zip"));
  });

  it("hands over the PDF for an HTML job without a known source", () => {
    expect(
      cvDownloadTarget("html", { ...job, tailoredSourceShape: null }),
    ).toEqual(target("pdf"));
    expect(cvDownloadTarget("html", job)).toEqual(target("pdf"));
  });

  it("hands over the PDF for a format this build does not know", () => {
    expect(
      cvDownloadTarget("bogus" as never, {
        ...job,
        tailoredSourceShape: "file",
      }),
    ).toEqual(target("pdf"));
  });
});
