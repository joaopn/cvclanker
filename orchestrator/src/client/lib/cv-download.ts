import type { CvSourceFormat } from "@shared/types";
import type { DownloadExtension } from "@/lib/download-filename";

export interface CvDownloadTarget {
  href: string;
  ext: DownloadExtension;
}

/**
 * What a job's CV download hands over: the tailored .docx on a Word profile,
 * else the PDF (an HTML profile's tailored page is not served yet). The PDF
 * views ("View PDF", the preview) are not this.
 */
export function cvDownloadTarget(
  format: CvSourceFormat,
  job: { id: string; updatedAt: string },
): CvDownloadTarget {
  const version = `?v=${encodeURIComponent(job.updatedAt)}`;
  const pdf: CvDownloadTarget = {
    href: `/pdfs/resume_${job.id}.pdf${version}`,
    ext: "pdf",
  };
  switch (format) {
    case "latex":
      return pdf;
    case "docx":
      return { href: `/pdfs/resume_${job.id}.docx${version}`, ext: "docx" };
    case "html":
      // The tailored page is not served yet; the PDF until it is.
      return pdf;
    default:
      format satisfies never;
      return pdf;
  }
}
