import { useSettings } from "@client/hooks/useSettings";
import { cvDownloadTarget } from "@client/lib/cv-download";
import type { Job } from "@shared/types";
import { Download, ExternalLink, FileText } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildDownloadFilename } from "@/lib/download-filename";

type DocKind = "cv" | "cover";

interface JobDocumentsPanelProps {
  job: Job;
}

/**
 * Inline CV + cover-letter PDF preview for live / interviewing jobs. Both PDFs
 * are generated during tailoring; here we just embed them (cache-busted on
 * `job.updatedAt`) so the user can review what they submitted without leaving
 * the detail panel.
 */
export const JobDocumentsPanel: React.FC<JobDocumentsPanelProps> = ({
  job,
}) => {
  const { cvSourceFormat, candidateName } = useSettings();
  const hasCv = Boolean(job.pdfPath);
  const hasCover = Boolean(job.coverLetterPdfPath);
  const [doc, setDoc] = useState<DocKind>(hasCv ? "cv" : "cover");

  // Keep the selected document valid as the job (or its rendered PDFs) change.
  useEffect(() => {
    if (doc === "cv" && !hasCv && hasCover) setDoc("cover");
    if (doc === "cover" && !hasCover && hasCv) setDoc("cv");
  }, [doc, hasCv, hasCover]);

  if (!hasCv && !hasCover) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/10 text-center">
        <FileText className="h-6 w-6 text-muted-foreground" />
        <div className="text-sm font-medium text-muted-foreground">
          No documents generated
        </div>
        <p className="max-w-[260px] text-xs text-muted-foreground/80">
          This application has no tailored CV or cover letter on file.
        </p>
      </div>
    );
  }

  const isCv = doc === "cv";
  const href = isCv
    ? `/pdfs/resume_${job.id}.pdf?v=${encodeURIComponent(job.updatedAt)}`
    : `/pdfs/cover_letter_${job.id}.pdf?v=${encodeURIComponent(job.updatedAt)}`;

  // Download hands over the editable artifact — the tailored source on a Word
  // or HTML profile. Open and the iframe below keep the PDF: it is the view
  // (a .docx or zip cannot render in a frame, and /pdfs serves the tailored
  // page only as an attachment). Cover letters are LaTeX-only, so they stay PDF.
  const download = isCv
    ? cvDownloadTarget(cvSourceFormat, job)
    : { href, ext: "pdf" as const };
  const downloadName = buildDownloadFilename({
    candidateName,
    kind: isCv ? "resume" : "cover",
    employer: job.employer,
    ext: download.ext,
  });

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {hasCv && (
          <Button
            size="sm"
            variant={isCv ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => setDoc("cv")}
          >
            CV
          </Button>
        )}
        {hasCover && (
          <Button
            size="sm"
            variant={!isCv ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => setDoc("cover")}
          >
            Cover Letter
          </Button>
        )}
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs"
        >
          <a href={href} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3 w-3" />
            Open
          </a>
        </Button>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
        >
          <a href={download.href} download={downloadName}>
            <Download className="h-3 w-3" />
            {download.ext === "docx" ? "Download .docx" : "Download"}
          </a>
        </Button>
      </div>
      <iframe
        key={doc}
        title={isCv ? "Compiled CV preview" : "Cover letter preview"}
        src={href}
        className="h-[70vh] min-h-[480px] w-full rounded-md border border-border/60 bg-background"
      />
    </div>
  );
};
