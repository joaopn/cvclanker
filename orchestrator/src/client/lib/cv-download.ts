import type { CvSourceFormat, Job } from "@shared/types";
import type { DownloadExtension } from "@/lib/download-filename";

export interface CvDownloadTarget {
  href: string;
  ext: DownloadExtension;
}

/**
 * What a job's CV download hands over: the tailored source on a Word or HTML
 * profile (the .docx; the page, or the zip when the CV was uploaded as one),
 * else the PDF. An HTML job whose source shape is unknown (a job read from a
 * list) or absent (a job with no tailored HTML source) gets the PDF rather
 * than a link that may 404. The PDF views ("View PDF", the preview) are not this.
 */
export function cvDownloadTarget(
  format: CvSourceFormat,
  job: Pick<Job, "id" | "updatedAt" | "tailoredSourceShape">,
): CvDownloadTarget {
  const source = (ext: DownloadExtension): CvDownloadTarget => ({
    href: `/pdfs/resume_${job.id}.${ext}?v=${encodeURIComponent(job.updatedAt)}`,
    ext,
  });
  switch (format) {
    case "latex":
      return source("pdf");
    case "docx":
      return source("docx");
    case "html":
      switch (job.tailoredSourceShape) {
        case "file":
          return source("html");
        case "bundle":
          return source("zip");
        default:
          return source("pdf");
      }
    default:
      format satisfies never;
      return source("pdf");
  }
}
