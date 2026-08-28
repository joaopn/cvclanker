import { logger } from "@infra/logger";
import * as repo from "@server/repositories/cover-letter-documents";
import { upsertJobPdf } from "@server/repositories/job-pdfs";
import * as jobsRepo from "@server/repositories/jobs";
import {
  RenderTemplateError,
  renderTemplate,
} from "@server/services/cv/render-template";
import {
  RunTectonicError,
  runTectonic,
} from "@server/services/cv/run-tectonic";
import { coverLetterJobBaseline } from "@shared/cover-letter-fields";
import type { CvFieldOverrides, Job } from "@shared/types";

/**
 * 5h cover-letter Render path. Substitutes the per-job overrides into
 * the active cover-letter doc's templated tex, runs tectonic, stores the
 * PDF bytes in `job_pdfs` and persists the canonical relative filename on
 * `jobs.coverLetterPdfPath`. No LLM call — just template + render.
 *
 * The resolved doc id is the job's pinned `coverLetterDocumentId` if
 * present, falling back to the most-recently-updated cover-letter doc.
 */
export interface RenderCoverLetterArgs {
  jobId: string;
}

export type RenderCoverLetterResult =
  | { success: true; job: Job; pdfPath: string }
  | { success: false; error: string };

export async function renderCoverLetterPdf(
  args: RenderCoverLetterArgs,
): Promise<RenderCoverLetterResult> {
  const job = await jobsRepo.getJobById(args.jobId);
  if (!job) {
    return { success: false, error: "Job not found." };
  }

  let docId = job.coverLetterDocumentId;
  if (!docId) {
    const summaries = await repo.listCoverLetterDocuments();
    docId = summaries[0]?.id ?? null;
  }
  if (!docId) {
    return {
      success: false,
      error:
        "No cover-letter template uploaded yet. Upload one from the Cover Letter page first.",
    };
  }

  const document = await repo.getCoverLetterDocumentById(docId);
  if (!document) {
    return { success: false, error: "Cover-letter document not found." };
  }
  if (!document.templatedTex || document.templatedTex.trim().length === 0) {
    return {
      success: false,
      error:
        "Cover-letter document has no templated tex. Re-extract it from the Cover Letter page.",
    };
  }
  const archive = await repo.getCoverLetterDocumentArchive(docId);
  if (!archive) {
    return { success: false, error: "Cover-letter archive missing." };
  }

  // The body's per-job baseline is EMPTY, not the uploaded letter's prose —
  // see coverLetterJobBaseline. A job that was never generated must not render
  // a PDF carrying the letter the user wrote for some other application.
  const effectiveValues: CvFieldOverrides = {
    ...coverLetterJobBaseline(document),
    ...(job.coverLetterFieldOverrides ?? {}),
  };

  let renderedTex: string;
  try {
    renderedTex = renderTemplate(document.templatedTex, effectiveValues);
  } catch (error) {
    if (error instanceof RenderTemplateError) {
      return {
        success: false,
        error: `Could not render the cover-letter template: ${error.message}`,
      };
    }
    throw error;
  }

  // Canonical relative filename — persisted on the job purely as an
  // existence flag; the bytes live in job_pdfs and are served from there.
  const pdfPath = `cover_letter_${args.jobId}.pdf`;

  let pdfBytes: Uint8Array;
  try {
    const result = await runTectonic({
      renderedTex,
      archive: new Uint8Array(archive),
    });
    pdfBytes = result.pdf;
  } catch (error) {
    if (error instanceof RunTectonicError) {
      return {
        success: false,
        error: `LaTeX compile failed: ${error.message}`,
      };
    }
    throw error;
  }

  await upsertJobPdf({
    jobId: args.jobId,
    kind: "cover_letter",
    data: Buffer.from(pdfBytes),
  });

  // Pin doc id if not already pinned (e.g. user clicked Render without
  // first running Generate).
  const pinUpdate =
    job.coverLetterDocumentId === document.id
      ? {}
      : { coverLetterDocumentId: document.id };

  await jobsRepo.updateJob(job.id, {
    ...pinUpdate,
    coverLetterPdfPath: pdfPath,
  });

  logger.info("Cover letter PDF rendered", {
    jobId: job.id,
    coverLetterDocumentId: document.id,
    pdfPath,
    bytes: pdfBytes.byteLength,
  });

  const updated = await jobsRepo.getJobById(job.id);
  if (!updated) {
    return { success: false, error: "Failed to reload job after render." };
  }
  return { success: true, job: updated, pdfPath };
}
