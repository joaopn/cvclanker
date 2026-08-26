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
 */

import { logger } from "@infra/logger";
import { getJobPdf, type JobPdfKind } from "@server/repositories/job-pdfs";
import { type Request, type Response, Router } from "express";

// Job ids are randomUUID(); the charset class stays a superset for safety.
const FILENAME_PATTERN = /^(resume|cover_letter)_([A-Za-z0-9_-]+)\.(pdf|docx)$/;

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
    // resume_docx kind, and only `resume` has one.
    if (extension === "docx" && prefix !== "resume") {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const kind: JobPdfKind =
      extension === "docx" ? "resume_docx" : (prefix as JobPdfKind);

    const data = await getJobPdf(jobId, kind);
    if (!data) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }

    // A .docx can't be previewed in a browser tab — serve it as a download.
    res.setHeader(
      "Content-Type",
      extension === "docx" ? DOCX_CONTENT_TYPE : "application/pdf",
    );
    // Disposition TYPE only, deliberately no `filename` parameter (B47).
    //
    // Per the HTML Standard's "determine the filename" algorithm a header
    // filename beats an anchor's `download`: unconditionally for `attachment`,
    // and for `inline` whenever the fetch is a trusted (same-origin) one —
    // which /pdfs always is. So pinning the URL's own basename overrode all
    // six download surfaces, each of which computes a far better name than
    // this route could ("<person>_<employer>" from the job and the active CV),
    // and every CV saved as `resume_<jobId>.pdf`. That was the regression this
    // route introduced when it replaced an `express.static` mount, which sent
    // no Content-Disposition at all.
    //
    // The type is kept as the explicit signal, not because either behaviour
    // depends on it: with no header whatsoever `application/pdf` still
    // previews and the Word MIME still downloads, which is exactly how it
    // behaved under `express.static`.
    res.setHeader(
      "Content-Disposition",
      extension === "docx" ? "attachment" : "inline",
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
