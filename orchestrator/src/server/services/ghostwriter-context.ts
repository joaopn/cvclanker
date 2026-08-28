import { badRequest, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import { coverLetterJobBaseline } from "@shared/cover-letter-fields";
import type { CoverLetterDocument, CvDocument, Job } from "@shared/types";
import * as jobsRepo from "../repositories/jobs";
import { getActiveCoverLetterDocument } from "./cover-letter/active";
import { resolveCvSourceFormat } from "./cv/cv-format";
import { getCvFormatNote } from "./cv/cv-format-note";
import { getActiveCvDocument } from "./cv-active";
import {
  getWritingLanguageLabel,
  resolveWritingOutputLanguage,
} from "./output-language";
import { loadPrompt } from "./prompts";
import { getEffectiveSettings } from "./settings";
import {
  getWritingStyle,
  stripLanguageDirectivesFromConstraints,
  type WritingStyle,
} from "./writing-style";

export type JobChatPromptContext = {
  job: Job;
  cv: CvDocument | null;
  style: WritingStyle;
  systemPrompt: string;
  jobSnapshot: string;
  briefSnapshot: string;
  cvSnapshot: string;
  coverLetterSnapshot: string;
};

/**
 * Hard cap on `suitabilityReason` length. The scorer prompt asks for "1-2
 * sentences" — a value past this is a sign of a regression (LLM ignoring
 * the constraint), not a user-input limit. Fail loud rather than silently
 * truncate so the bug surfaces.
 */
const SUITABILITY_REASON_HARD_CAP = 4000;

function buildJobSnapshot(job: Job): string {
  if (
    job.suitabilityReason &&
    job.suitabilityReason.length > SUITABILITY_REASON_HARD_CAP
  ) {
    throw new Error(
      `suitabilityReason length ${job.suitabilityReason.length} exceeds the ${SUITABILITY_REASON_HARD_CAP}-char hard cap (regression detector — the scorer should emit 1-2 sentences).`,
    );
  }

  const snapshot = {
    event: "job.completed",
    sentAt: new Date().toISOString(),
    job: {
      id: job.id,
      source: job.source,
      title: job.title,
      employer: job.employer,
      location: job.location,
      salary: job.salary,
      status: job.status,
      jobUrl: job.jobUrl,
      applicationLink: job.applicationLink,
      suitabilityCategory: job.suitabilityCategory,
      suitabilityReason: job.suitabilityReason ?? "",
      jobDescription: job.jobDescription ?? "",
    },
  };

  return JSON.stringify(snapshot, null, 2);
}

function buildBriefSnapshot(brief: string): string {
  return brief.trim();
}

function buildCvSnapshot(job: Job, cv: CvDocument | null): string {
  const fields = cv?.fields ?? [];
  const overrides = job.tailoredFields ?? {};

  // Render each field with its CURRENT value (override or original).
  const fieldsView = fields.map((field) => ({
    id: field.id,
    role: field.role,
    value: overrides[field.id] ?? field.value,
    overridden: Object.hasOwn(overrides, field.id),
  }));

  const snapshot = {
    cv: cv
      ? {
          id: cv.id,
          name: cv.name,
        }
      : null,
    fields: fieldsView,
    ats: {
      matched: job.tailoringMatched ?? [],
      skipped: job.tailoringSkipped ?? [],
    },
  };

  return JSON.stringify(snapshot, null, 2);
}

/**
 * Resolve the cover letter the user actually sees, mirroring
 * `CoverLetterEditTab`: when an active template exists, the body override
 * wins, then the legacy draft, then the per-job baseline — which is EMPTY,
 * not the template's own letter. Without a template it's just the legacy
 * `coverLetterDraft`. If this drifts from the pane, the model tailors against
 * text the user isn't looking at.
 */
function buildCoverLetterSnapshot(
  job: Job,
  coverLetter: CoverLetterDocument | null,
): string {
  const bodyField = coverLetter?.fields.find((field) => field.role === "body");
  if (bodyField && coverLetter) {
    const override = job.coverLetterFieldOverrides?.[bodyField.id];
    if (override) return override.trim();
    const draft = (job.coverLetterDraft ?? "").trim();
    // A legacy draft equal to the template's own body is the uploaded letter,
    // not something written for this job. The pane drops it for that reason
    // (seedOverrides), and this must drop it for the same one — handing the
    // model boilerplate the user cannot see is the drift this function exists
    // to avoid.
    const documentBody = (
      coverLetter.defaultFieldValues[bodyField.id] ?? ""
    ).trim();
    if (draft && draft !== documentBody) return draft;
    // NOT the template's body: the pane shows the per-job baseline, which is
    // empty until something writes a real letter for THIS job.
    return coverLetterJobBaseline(coverLetter)[bodyField.id] ?? "";
  }
  return (job.coverLetterDraft ?? "").trim();
}

async function buildSystemPrompt(
  style: WritingStyle,
  brief: string,
): Promise<string> {
  const resolvedLanguage = resolveWritingOutputLanguage({
    style,
    sample: brief,
  });
  const outputLanguage = getWritingLanguageLabel(resolvedLanguage.language);
  const effectiveConstraints = stripLanguageDirectivesFromConstraints(
    style.constraints,
  );

  const settings = await getEffectiveSettings();
  const cvFormatNote = await getCvFormatNote(resolveCvSourceFormat(settings));

  const loaded = await loadPrompt("ghostwriter-system", {
    cvFormatNote,
    outputLanguage,
    tone: style.tone,
    formality: style.formality,
    constraintsSentence: effectiveConstraints
      ? `Writing constraints: ${effectiveConstraints}`
      : "",
    avoidTermsSentence: style.doNotUse
      ? `Avoid these terms: ${style.doNotUse}`
      : "",
  });
  return loaded.system;
}

export async function buildJobChatPromptContext(
  jobId: string,
): Promise<JobChatPromptContext> {
  const job = await jobsRepo.getJobById(jobId);
  if (!job) {
    throw notFound("Job not found");
  }

  const style = await getWritingStyle();

  let cv: CvDocument | null = null;
  try {
    cv = await getActiveCvDocument();
  } catch (error) {
    logger.warn("Failed to load active CV for job chat context", {
      jobId,
      error: sanitizeUnknown(error),
    });
  }

  let coverLetter: CoverLetterDocument | null = null;
  try {
    coverLetter = await getActiveCoverLetterDocument();
  } catch (error) {
    logger.warn("Failed to load active cover letter for job chat context", {
      jobId,
      error: sanitizeUnknown(error),
    });
  }

  const brief = cv?.personalBrief?.trim() ?? "";
  const briefSnapshot = buildBriefSnapshot(brief);
  const cvSnapshot = buildCvSnapshot(job, cv);
  const coverLetterSnapshot = buildCoverLetterSnapshot(job, coverLetter);
  const systemPrompt = await buildSystemPrompt(style, brief);
  const jobSnapshot = buildJobSnapshot(job);

  if (!jobSnapshot.trim()) {
    throw badRequest("Unable to build job context");
  }

  logger.info("Built job chat context", {
    jobId,
    includesBrief: Boolean(briefSnapshot),
    includesCv: Boolean(cv),
    includesCoverLetter: Boolean(coverLetterSnapshot),
    contextStats: sanitizeUnknown({
      systemChars: systemPrompt.length,
      jobChars: jobSnapshot.length,
      briefChars: briefSnapshot.length,
      cvChars: cvSnapshot.length,
      coverLetterChars: coverLetterSnapshot.length,
    }),
  });

  return {
    job,
    cv,
    style,
    systemPrompt,
    jobSnapshot,
    briefSnapshot,
    cvSnapshot,
    coverLetterSnapshot,
  };
}
