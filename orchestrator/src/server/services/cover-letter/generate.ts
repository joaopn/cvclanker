import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import { getActiveCvDocument } from "@server/services/cv-active";
import { LlmService } from "@server/services/llm/service";
import type { JsonSchemaDefinition } from "@server/services/llm/types";
import { resolveLlmModel } from "@server/services/modelSelection";
import { loadPrompt } from "@server/services/prompts";
import { getEffectiveSettings } from "@server/services/settings";
import {
  getWritingStyle,
  stripLanguageDirectivesFromConstraints,
  type WritingStyle,
} from "@server/services/writing-style";
import { DEFAULT_COVER_LETTER_INSTRUCTIONS } from "@shared/settings-registry";
import {
  CHAT_STYLE_MANUAL_LANGUAGE_LABELS,
  type ChatStyleManualLanguage,
  type CvField,
  type CvFieldOverrides,
  type Job,
} from "@shared/types";
import { getActiveCoverLetterDocument } from "./active";

/**
 * Cover-letter Generate path. Mirrors `services/cv/llm-adjust-content`:
 * the LLM receives every tailorable field on the active cover-letter
 * document and emits a list of `{ fieldId, newValue }` patches. Server
 * validates each patch against the doc's known field ids, drops any
 * unknown ones, and merges the rest into `jobs.coverLetterFieldOverrides`.
 *
 * This lets the LLM tailor the salutation, recipient, subject, and
 * (optional) signoff per job — not just the body. Templates that only
 * templatize the body still work: the LLM receives one field, returns
 * one patch, prompt instructs it to include greeting/signoff in the
 * body string. Templates that templatize multiple fields get full
 * per-job tailoring with greeting/recipient/title written into their
 * respective fields and the body kept paragraphs-only.
 *
 * `patchesJson` is a JSON-encoded string instead of an array of objects
 * — strict structured-output mode (OpenAI) requires
 * `additionalProperties: false` on every object schema, which interacts
 * poorly when patches share the same flat shape. Encoding as a string
 * sidesteps the constraint; the server validates each entry after
 * parsing. Same trick used by `cv-adjust`.
 */
export interface GenerateCoverLetterArgs {
  jobId: string;
}

export type GenerateCoverLetterResult =
  | { success: true; job: Job }
  | { success: false; error: string };

const GENERATE_SCHEMA: JsonSchemaDefinition = {
  name: "cover_letter_generate_result",
  schema: {
    type: "object",
    properties: {
      patchesJson: {
        type: "string",
        description:
          "Stringified JSON array of patches: [{ fieldId, newValue }]. Each fieldId must reference a CvField on the cover-letter doc; the newValue is the per-job string. Server JSON.parses and validates each entry.",
      },
    },
    required: ["patchesJson"],
    additionalProperties: false,
  },
};

interface GeneratePatch {
  fieldId: string;
  newValue: string;
}

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\\(?:immediate\s*)?write18\b/,
    description: "\\write18 (shell-escape)",
  },
  { pattern: /\\openout\b/, description: "\\openout (file write)" },
  { pattern: /\\input\s*\{\s*\//, description: "\\input{} with absolute path" },
  {
    pattern: /\\input\s*\{\s*\.\.\//,
    description: "\\input{} with parent-traversal path",
  },
];

function buildFieldsView(
  fields: CvField[],
  overrides: CvFieldOverrides,
): Array<{ id: string; role: string; value: string }> {
  return fields.map((field) => ({
    id: field.id,
    role: field.role,
    value: overrides[field.id] ?? field.value,
  }));
}

export async function generateCoverLetter(
  args: GenerateCoverLetterArgs,
): Promise<GenerateCoverLetterResult> {
  const job = await jobsRepo.getJobById(args.jobId);
  if (!job) {
    return { success: false, error: "Job not found." };
  }

  const coverLetter = await getActiveCoverLetterDocument();
  if (!coverLetter) {
    return {
      success: false,
      error:
        "No cover-letter template uploaded yet. Upload one from the Cover Letter page first.",
    };
  }

  const bodyField =
    coverLetter.fields.find((field) => field.role === "body") ?? null;
  if (!bodyField) {
    return {
      success: false,
      error:
        "Active cover-letter template has no body field. Re-extract the cover letter from the Cover Letter page.",
    };
  }

  const cv = await getActiveCvDocument();
  const personalBrief = cv?.personalBrief ?? "";

  const tailoredCvFields = buildFieldsView(
    cv?.fields ?? [],
    job.tailoredFields ?? {},
  );

  const coverLetterFieldsView = buildFieldsView(
    coverLetter.fields,
    job.coverLetterFieldOverrides ?? {},
  );

  const [model, writingStyle, settings] = await Promise.all([
    resolveLlmModel("tailoring"),
    getWritingStyle(),
    getEffectiveSettings(),
  ]);

  const styleVars = buildWritingStyleVars(writingStyle);

  const prompt = await loadPrompt("cover-letter-generate", {
    jobDescription: job.jobDescription ?? "(empty)",
    personalBrief: personalBrief || "(empty — no candidate brief on file)",
    tailoredCvFieldsJson: JSON.stringify(tailoredCvFields, null, 2),
    coverLetterFieldsJson: JSON.stringify(coverLetterFieldsView, null, 2),
    companyName: job.employer ?? "the company",
    roleTitle: job.title ?? "the role",
    bodyFieldId: bodyField.id,
    // The prompt is a structural shell; these instructions ARE the letter
    // policy, so an empty value must fall back to the shipped one - a bare
    // shell tells the model nothing about length, structure, or voice.
    coverLetterInstructionsText:
      settings.coverLetterInstructions?.value ||
      DEFAULT_COVER_LETTER_INSTRUCTIONS,
    language: styleVars.outputLanguage,
    ...styleVars,
  });

  const llm = new LlmService();
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (prompt.system) messages.push({ role: "system", content: prompt.system });
  messages.push({ role: "user", content: prompt.user });

  const subject =
    job.title && job.employer
      ? `${job.title} @ ${job.employer}`
      : job.title || job.employer || undefined;

  const result = await llm.callJson<{ patchesJson: unknown }>({
    model,
    messages,
    jsonSchema: GENERATE_SCHEMA,
    maxRetries: 1,
    label: "generate cover letter",
    subject,
    jobId: job.id,
  });

  if (!result.success) {
    return { success: false, error: `LLM call failed: ${result.error}` };
  }

  const { patchesJson } = result.data;
  if (typeof patchesJson !== "string" || patchesJson.trim().length === 0) {
    return {
      success: false,
      error: "Model returned an empty patches list.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(patchesJson);
  } catch (error) {
    return {
      success: false,
      error: `Model returned malformed patches JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      success: false,
      error: "Model returned patches in an unexpected shape (expected array).",
    };
  }

  const fieldIds = new Set(coverLetter.fields.map((field) => field.id));
  const patches: GeneratePatch[] = [];
  const droppedUnknown: string[] = [];
  let droppedMalformed = 0;
  let droppedForbidden = 0;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      droppedMalformed += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const fieldId = record.fieldId;
    const newValue = record.newValue;
    if (typeof fieldId !== "string" || fieldId.length === 0) {
      droppedMalformed += 1;
      continue;
    }
    if (!fieldIds.has(fieldId)) {
      droppedUnknown.push(fieldId);
      continue;
    }
    if (typeof newValue !== "string") {
      droppedMalformed += 1;
      continue;
    }
    if (FORBIDDEN_PATTERNS.some((guard) => guard.pattern.test(newValue))) {
      droppedForbidden += 1;
      continue;
    }
    patches.push({ fieldId, newValue });
  }

  logger.info("Cover-letter Generate patches resolved", {
    jobId: job.id,
    coverLetterDocumentId: coverLetter.id,
    rawCount: parsed.length,
    appliedCount: patches.length,
    droppedUnknown: droppedUnknown.slice(0, 10),
    droppedMalformed,
    droppedForbidden,
  });

  // The body field is mandatory — without it Render cannot produce a
  // per-job PDF that's actually tailored.
  const hasBody = patches.some((patch) => patch.fieldId === bodyField.id);
  if (!hasBody) {
    return {
      success: false,
      error: `Model produced no patch for the body field "${bodyField.id}". The body is required for per-job tailoring.`,
    };
  }

  const merged: CvFieldOverrides = {
    ...(job.coverLetterFieldOverrides ?? {}),
  };
  for (const patch of patches) {
    merged[patch.fieldId] = patch.newValue;
  }

  const pinUpdate =
    job.coverLetterDocumentId && job.coverLetterDocumentId === coverLetter.id
      ? {}
      : { coverLetterDocumentId: coverLetter.id };

  await jobsRepo.updateJob(job.id, {
    ...pinUpdate,
    coverLetterFieldOverrides: merged,
  });

  const updated = await jobsRepo.getJobById(job.id);
  if (!updated) {
    return { success: false, error: "Failed to reload job after update." };
  }
  return { success: true, job: updated };
}

function buildWritingStyleVars(style: WritingStyle): Record<string, string> {
  const language: ChatStyleManualLanguage =
    style.languageMode === "manual" ? style.manualLanguage : "english";
  const effectiveConstraints = stripLanguageDirectivesFromConstraints(
    style.constraints,
  );
  return {
    outputLanguage: CHAT_STYLE_MANUAL_LANGUAGE_LABELS[language],
    tone: style.tone,
    formality: style.formality,
    constraintsSentence: effectiveConstraints
      ? `Writing constraints: ${effectiveConstraints}`
      : "",
    avoidTermsSentence: style.doNotUse
      ? `Avoid these terms: ${style.doNotUse}`
      : "",
  };
}
