import { badRequest, conflict, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { tailoringFailureSummary } from "@shared/tailoring-failure";
import type {
  CvDocument,
  CvFieldOverrides,
  Job,
  JobChatMessage,
} from "@shared/types";
import * as cvRepo from "../repositories/cv-documents";
import * as jobChatRepo from "../repositories/ghostwriter";
import * as jobsRepo from "../repositories/jobs";
import { getActiveCoverLetterDocument } from "./cover-letter/active";
import { applyBriefEdit, applyCvEditOps } from "./cv-edit-ops";
import { getActiveCvDocument } from "./cv-active";
import { generatePdf } from "./pdf";

async function loadAcceptableMessage(input: {
  jobId: string;
  messageId: string;
}): Promise<JobChatMessage> {
  const message = await jobChatRepo.getMessageById(input.messageId);
  if (!message || message.jobId !== input.jobId) {
    throw notFound("Message not found for this job");
  }
  if (!message.proposedEdit) {
    throw badRequest("Message has no proposed edit to act on");
  }
  if (message.editStatus && message.editStatus !== "pending") {
    throw conflict(
      `Edit was already resolved (status: ${message.editStatus})`,
    );
  }
  return message;
}

export type AcceptEditResult =
  | { kind: "cv-edit"; message: JobChatMessage; job: Job }
  | { kind: "brief-edit"; message: JobChatMessage; cv: CvDocument }
  | { kind: "cover-letter-edit"; message: JobChatMessage; job: Job };

export async function acceptEditForJob(input: {
  jobId: string;
  messageId: string;
}): Promise<AcceptEditResult> {
  const message = await loadAcceptableMessage(input);
  const proposed = message.proposedEdit;
  if (!proposed) {
    throw badRequest("Message has no proposed edit to act on");
  }

  if (proposed.kind === "cv-edit") {
    const job = await jobsRepo.getJobById(input.jobId);
    if (!job) throw notFound("Job not found");
    if (!job.cvDocumentId) {
      throw badRequest("Job is not pinned to a CV document");
    }
    const cv = await cvRepo.getCvDocumentById(job.cvDocumentId);
    if (!cv) {
      throw notFound("Pinned CV document not found");
    }

    const lockedSet = new Set(job.cvFieldLocks ?? []);
    const blockedOps = proposed.edits.filter((op) => lockedSet.has(op.fieldId));
    if (blockedOps.length > 0) {
      const ids = blockedOps.map((op) => op.fieldId).join(", ");
      throw conflict(
        `Cannot accept edit on locked field(s): ${ids}. Unlock from the Edit tab first.`,
      );
    }

    const previousOverrides: CvFieldOverrides = job.tailoredFields ?? {};
    const nextOverrides = applyCvEditOps(
      cv.fields,
      previousOverrides,
      proposed.edits,
    );

    await jobsRepo.updateJob(job.id, { tailoredFields: nextOverrides });

    const pdf = await generatePdf({
      jobId: job.id,
      cvDocumentId: job.cvDocumentId,
      overrides: nextOverrides,
    });
    if (!pdf.success) {
      // Roll back the override map so a render failure doesn't desync the
      // persisted tailoredFields from the PDF on disk.
      await jobsRepo.updateJob(job.id, { tailoredFields: previousOverrides });
      logger.warn("PDF render failed during accept-edit; rolled back", {
        jobId: job.id,
        messageId: message.id,
        reason: sanitizeUnknown(pdf.error),
      });
      // Summary only — this reaches the ghostwriter toast. The full log is
      // still logged above via sanitizeUnknown.
      throw badRequest(
        `PDF render failed after edit: ${tailoringFailureSummary(pdf.error) || "unknown"}`,
      );
    }

    if (pdf.pdfPath !== undefined) {
      await jobsRepo.updateJob(job.id, { pdfPath: pdf.pdfPath });
    }

    const updatedMessage = await jobChatRepo.setMessageEditStatus(
      message.id,
      "accepted",
    );
    const updatedJob = await jobsRepo.getJobById(job.id);
    if (!updatedMessage || !updatedJob) {
      throw new Error("Failed to load message/job after accept-edit");
    }
    return { kind: "cv-edit", message: updatedMessage, job: updatedJob };
  }

  if (proposed.kind === "cover-letter-edit") {
    const job = await jobsRepo.getJobById(input.jobId);
    if (!job) throw notFound("Job not found");

    // Write to the SAME place the cover-letter pane reads from. When an active
    // template exists the pane shows `coverLetterFieldOverrides[bodyFieldId]`
    // (it takes precedence over `coverLetterDraft`), so writing only
    // `coverLetterDraft` would leave the live pane unchanged — the
    // "accepted but nothing updated" bug. Mirror `CoverLetterPane.saveOverride`.
    const coverLetter = await getActiveCoverLetterDocument();
    const bodyFieldId =
      coverLetter?.fields.find((field) => field.role === "body")?.id ?? null;

    if (bodyFieldId) {
      await jobsRepo.updateJob(job.id, {
        coverLetterFieldOverrides: {
          ...(job.coverLetterFieldOverrides ?? {}),
          [bodyFieldId]: proposed.draft,
        },
      });
    } else {
      await jobsRepo.updateJob(job.id, { coverLetterDraft: proposed.draft });
    }

    const updatedMessage = await jobChatRepo.setMessageEditStatus(
      message.id,
      "accepted",
    );
    const updatedJob = await jobsRepo.getJobById(job.id);
    if (!updatedMessage || !updatedJob) {
      throw new Error("Failed to load message/job after accept-edit");
    }
    return { kind: "cover-letter-edit", message: updatedMessage, job: updatedJob };
  }

  // brief-edit: write through to the active CV document's personal_brief.
  const cv = await getActiveCvDocument();
  if (!cv) throw notFound("No active CV document to edit brief on");

  const nextBrief = applyBriefEdit(cv.personalBrief, proposed);
  const updatedCv = await cvRepo.updateCvDocument(cv.id, {
    personalBrief: nextBrief,
  });
  if (!updatedCv) throw notFound("CV document not found after update");

  const updatedMessage = await jobChatRepo.setMessageEditStatus(
    message.id,
    "accepted",
  );
  if (!updatedMessage) throw notFound("Message not found after status update");

  return { kind: "brief-edit", message: updatedMessage, cv: updatedCv };
}

export async function rejectEditForJob(input: {
  jobId: string;
  messageId: string;
}): Promise<JobChatMessage> {
  const message = await loadAcceptableMessage(input);
  const updated = await jobChatRepo.setMessageEditStatus(
    message.id,
    "rejected",
  );
  if (!updated) throw notFound("Message not found");
  return updated;
}
