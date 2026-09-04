import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import { getActiveCvDocument } from "@server/services/cv-active";
import { generatePdf } from "@server/services/pdf";
import { splitTailoringFailure } from "@shared/tailoring-failure";
import type { Job } from "@shared/types";

export interface RenderCvArgs {
  jobId: string;
}

export type RenderCvResult =
  | { success: true; job: Job; pdfPath: string }
  | { success: false; error: string };

/**
 * 5i manual CV render. Substitutes the per-job `tailoredFields` overrides
 * into the resolved CV doc's templated tex, runs tectonic, stores the PDF
 * bytes in `job_pdfs` and persists the canonical relative filename on
 * `jobs.pdfPath`. No LLM call — just template + render.
 *
 * The resolved doc id is the job's pinned `cvDocumentId` if present,
 * falling back to the most-recently-updated CV doc (the same fallback
 * the cover-letter render uses).
 *
 * Unlike the tailoring path, baseline-equivalent renders are allowed.
 * "User clicked Render" permits a recompile against current saved state
 * even when that state has zero or no-op overrides.
 */
export async function renderCvPdf(
  args: RenderCvArgs,
): Promise<RenderCvResult> {
  const job = await jobsRepo.getJobById(args.jobId);
  if (!job) {
    return { success: false, error: "Job not found." };
  }

  let docId = job.cvDocumentId;
  if (!docId) {
    const active = await getActiveCvDocument();
    docId = active?.id ?? null;
  }
  if (!docId) {
    return {
      success: false,
      error: "No CV uploaded yet. Upload a CV from the CV page first.",
    };
  }

  const pdf = await generatePdf({
    jobId: job.id,
    cvDocumentId: docId,
    overrides: job.tailoredFields ?? {},
    allowBaselineRender: true,
  });
  if (!pdf.success || !pdf.pdfPath) {
    // Summary only: this one surfaces in a toast, which a compiler log would
    // overflow. Nothing on this path persists the reason — Render is not a
    // tailoring run — so the detail is logged here or it is lost outright.
    const { summary, detail } = splitTailoringFailure(pdf.error);
    if (detail) {
      logger.warn("CV render failed", { jobId: job.id, detail });
    }
    return {
      success: false,
      error: summary || "Failed to render CV PDF.",
    };
  }

  const pinUpdate =
    job.cvDocumentId === docId ? {} : { cvDocumentId: docId };

  await jobsRepo.updateJob(job.id, {
    ...pinUpdate,
    pdfPath: pdf.pdfPath,
  });

  logger.info("CV PDF rendered (manual)", {
    jobId: job.id,
    cvDocumentId: docId,
    pdfPath: pdf.pdfPath,
  });

  const updated = await jobsRepo.getJobById(job.id);
  if (!updated) {
    return { success: false, error: "Failed to reload job after render." };
  }
  return { success: true, job: updated, pdfPath: pdf.pdfPath };
}
