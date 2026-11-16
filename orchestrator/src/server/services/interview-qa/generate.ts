import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import { resolveCvSourceFormat } from "@server/services/cv/cv-format";
import { cvFieldText } from "@server/services/cv/html/field-text";
import { getActiveCvDocument } from "@server/services/cv-active";
import { LlmService } from "@server/services/llm/service";
import type { JsonSchemaDefinition } from "@server/services/llm/types";
import { resolveLlmModel } from "@server/services/modelSelection";
import { loadPrompt } from "@server/services/prompts";
import { getEffectiveSettings } from "@server/services/settings";
import type { CvField, CvFieldOverrides, Job } from "@shared/types";

/**
 * Per-job Interview QA generation. The LLM receives the job description,
 * the candidate's personal brief, and their per-job tailored CV fields,
 * and returns a single `strategyMarkdown` string — a freeform interview
 * strategy (narrative + questions to prepare for + questions to ask).
 * The server persists it verbatim to `jobs.interviewPrep`.
 *
 * Manual-only: nothing auto-triggers this. It runs when the user clicks
 * Generate in the Interview QA tab. `steer` is the optional free-text
 * steering from that tab's textbox (may be empty).
 *
 * Output is the LLM's markdown inside one string field (same `*Json`/
 * single-string convention as `cv-generate-brief`) rather than a
 * structured object — we want freeform prose, not a fixed schema.
 */
export interface GenerateInterviewPrepArgs {
  jobId: string;
  steer?: string;
}

export type GenerateInterviewPrepResult =
  | { success: true; job: Job }
  | { success: false; error: string };

const GENERATE_SCHEMA: JsonSchemaDefinition = {
  name: "interview_qa_result",
  schema: {
    type: "object",
    properties: {
      strategyMarkdown: {
        type: "string",
        description:
          "The interview strategy written as markdown: a core narrative, questions the candidate is likely to be asked (with how to play each), and high-leverage questions to ask the interviewer.",
      },
    },
    required: ["strategyMarkdown"],
    additionalProperties: false,
  },
};

const LIVE_STATUSES = new Set<Job["status"]>(["applied", "in_progress"]);

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

export async function generateInterviewPrep(
  args: GenerateInterviewPrepArgs,
): Promise<GenerateInterviewPrepResult> {
  const job = await jobsRepo.getJobById(args.jobId);
  if (!job) {
    return { success: false, error: "Job not found." };
  }

  if (!LIVE_STATUSES.has(job.status)) {
    return {
      success: false,
      error:
        "Interview QA is only available for jobs you've applied to or are interviewing for.",
    };
  }

  const cv = await getActiveCvDocument();
  const personalBrief = cv?.personalBrief ?? "";
  // The CV's values as text (an HTML CV's markup dropped).
  const cvFormat = resolveCvSourceFormat(await getEffectiveSettings());
  const tailoredCvFields = buildFieldsView(
    cv?.fields ?? [],
    job.tailoredFields ?? {},
  ).map((field) => ({ ...field, value: cvFieldText(field.value, cvFormat) }));

  const model = await resolveLlmModel("tailoring");

  const prompt = await loadPrompt("interview-qa-generate", {
    jobDescription: job.jobDescription ?? "(empty)",
    companyName: job.employer ?? "the company",
    roleTitle: job.title ?? "the role",
    personalBrief: personalBrief || "(empty — no candidate brief on file)",
    tailoredCvFieldsJson: JSON.stringify(tailoredCvFields, null, 2),
    userSteer: args.steer?.trim() || "",
  });

  const llm = new LlmService();
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (prompt.system) messages.push({ role: "system", content: prompt.system });
  messages.push({ role: "user", content: prompt.user });

  const subject =
    job.title && job.employer
      ? `${job.title} @ ${job.employer}`
      : job.title || job.employer || undefined;

  const result = await llm.callJson<{ strategyMarkdown: unknown }>({
    model,
    messages,
    jsonSchema: GENERATE_SCHEMA,
    maxRetries: 1,
    label: "generate interview QA",
    subject,
    jobId: job.id,
  });

  if (!result.success) {
    return { success: false, error: `LLM call failed: ${result.error}` };
  }

  const { strategyMarkdown } = result.data;
  if (typeof strategyMarkdown !== "string" || strategyMarkdown.trim().length === 0) {
    return {
      success: false,
      error: "Model returned an empty interview strategy.",
    };
  }

  logger.info("Interview QA generated", {
    jobId: job.id,
    chars: strategyMarkdown.length,
    steered: Boolean(args.steer?.trim()),
  });

  await jobsRepo.updateJob(job.id, { interviewPrep: strategyMarkdown });

  const updated = await jobsRepo.getJobById(job.id);
  if (!updated) {
    return { success: false, error: "Failed to reload job after update." };
  }
  return { success: true, job: updated };
}
