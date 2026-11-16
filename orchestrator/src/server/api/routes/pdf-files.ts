/**
 * Serves generated job documents from the `job_pdfs` BLOB table.
 *
 * Mounted at `/pdfs` OUTSIDE `/api` — deliberately auth-exempt, exactly like
 * the `express.static(data/pdfs)` mount it replaces (`requiresAuth` exempts
 * non-/api GET/HEAD). URL shape is unchanged so no client code moves:
 * `/pdfs/resume_<jobId>.pdf` and `/pdfs/cover_letter_<jobId>.pdf`, with the
 * client's `?v=<updatedAt>` cache-buster ignored server-side. Missing PDFs
 * now 404 instead of falling through to the SPA index.html.
 *
 * `/pdfs/resume_<jobId>.docx` serves the tailored Word document on a Word
 * profile — the authoritative artifact, of which the `resume` PDF is the
 * converted view. There is no `cover_letter_*.docx`: cover letters are
 * LaTeX-only, so that filename 404s rather than mapping to a kind.
 *
 * `/pdfs/resume_<jobId>.html` and `.zip` serve the tailored source on an HTML
 * profile (the `resume_html` kind), each only when the stored bytes have that
 * shape. /pdfs is same-origin and auth-exempt and the session token lives in
 * sessionStorage, so the page must never run here: both are attachments,
 * sandboxed by CSP, with sniffing off.
 */

import { logger } from "@infra/logger";
import { getJobPdf, type JobPdfKind } from "@server/repositories/job-pdfs";
import { looksLikeZip } from "@server/services/cv/html/zip-reader";
import { type Request, type Response, Router } from "express";

// Job ids are randomUUID(); the charset class stays a superset for safety.
const FILENAME_PATTERN =
  /^(resume|cover_letter)_([A-Za-z0-9_-]+)\.(pdf|docx|html|zip)$/;

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Per extension: the kind it reads (null: the prefix's own), whether the
 * stored bytes must be a zip (null: any), and the content type.
 */
const SERVED = {
  pdf: { kind: null, zip: null, contentType: "application/pdf" },
  docx: { kind: "resume_docx", zip: null, contentType: DOCX_CONTENT_TYPE },
  html: {
    kind: "resume_html",
    zip: false,
    contentType: "text/html; charset=utf-8",
  },
  zip: { kind: "resume_html", zip: true, contentType: "application/zip" },
} as const satisfies Record<
  string,
  { kind: JobPdfKind | null; zip: boolean | null; contentType: string }
>;

export const pdfFilesRouter = Router();

pdfFilesRouter.get("/:filename", async (req: Request, res: Response) => {
  try {
    const match = FILENAME_PATTERN.exec(req.params.filename);
    if (!match) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const prefix = match[1];
    const jobId = match[2];
    const extension = match[3];

    // The prefix is no longer the kind verbatim: a .docx request maps to the
    // resume_docx kind, .html and .zip to resume_html, and only `resume` has
    // them.
    const served = SERVED[extension as keyof typeof SERVED];
    if (served.kind !== null && prefix !== "resume") {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const kind = served.kind ?? (prefix as JobPdfKind);

    const data = await getJobPdf(jobId, kind);
    if (!data || (served.zip !== null && looksLikeZip(data) !== served.zip)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }

    res.setHeader("Content-Type", served.contentType);
    if (extension === "html" || extension === "zip") {
      res.setHeader("Content-Security-Policy", "sandbox");
      res.setHeader("X-Content-Type-Options", "nosniff");
    }
    // Disposition TYPE only, deliberately no `filename` parameter (B47).
    //
    // Per the HTML Standard's "determine the filename" algorithm a header
    // filename beats an anchor's `download`: unconditionally for `attachment`,
    // and for `inline` whenever the fetch is a trusted (same-origin) one —
    // which /pdfs always is. So pinning the URL's own basename overrode all
    // six download surfaces, each of which computes a far better name than
    // this route could (`buildDownloadFilename`, from the job and the
    // `candidateName` setting), and every CV saved as `resume_<jobId>.pdf`.
    // That was the regression this route introduced when it replaced an
    // `express.static` mount, which sent no Content-Disposition at all.
    //
    // For a PDF and a .docx the type is the explicit signal, not because
    // either behaviour depends on it: with no header whatsoever
    // `application/pdf` still previews and the Word MIME still downloads,
    // which is exactly how it behaved under `express.static`. For a page it
    // is the first protection: `text/html` without `attachment` would render
    // in the tab, where the sandbox CSP above is the second layer.
    res.setHeader(
      "Content-Disposition",
      extension === "pdf" ? "inline" : "attachment",
    );
    res.send(data);
  } catch (error) {
    logger.error("Failed to serve job PDF", {
      route: "/pdfs/:filename",
      filename: req.params.filename,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) {
      res.status(500).type("text/plain").send("Internal error");
    }
  }
});
