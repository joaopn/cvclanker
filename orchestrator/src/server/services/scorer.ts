/**
 * Service for scoring job suitability using AI.
 *
 * Emits a categorical suitability assessment (`very_good_fit | good_fit |
 * bad_fit`) instead of a 0-100 numeric score. The "missing salary" penalty
 * (when enabled) demotes the category by one tier so a great-on-paper match
 * with no salary disclosure surfaces below other comparable matches.
 */

import { AppError } from "@infra/errors";
import { logger } from "@infra/logger";
import { DEFAULT_SCORING_INSTRUCTIONS } from "@shared/settings-registry";
import {
  SUITABILITY_CATEGORIES,
  SUITABILITY_CATEGORY_RANK,
  type Job,
  type SuitabilityCategory,
} from "@shared/types";
import { LlmService } from "./llm/service";
import type { JsonSchemaDefinition } from "./llm/types";
import { resolveLlmModel } from "./modelSelection";
import { loadPrompt } from "./prompts";
import { getEffectiveSettings } from "./settings";

/**
 * Minimum job-description length below which we refuse to score. Scoring on
 * a title-only listing produces garbage assessments (LLM has nothing to
 * judge against the brief), so we'd rather leave the row unscored and
 * surface the problem.
 */
const MIN_SCOREABLE_DESCRIPTION_CHARS = 100;

export class JobNotScoreableError extends AppError {
  constructor(args: { jobId: string; observed: number; required: number }) {
    super({
      status: 422,
      code: "UNPROCESSABLE_ENTITY",
      message: `Cannot score job — description is ${args.observed} chars (need ≥ ${args.required}). Re-fetch the URL or paste the full description.`,
      details: { jobId: args.jobId, observed: args.observed, required: args.required },
    });
    this.name = "JobNotScoreableError";
  }
}

interface SuitabilityResult {
  category: SuitabilityCategory;
  reason: string;
}

type ScoringPreferences = {
  instructions: string;
};

/** JSON schema for suitability scoring response */
const SCORING_SCHEMA: JsonSchemaDefinition = {
  name: "job_suitability_category",
  schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: [...SUITABILITY_CATEGORIES],
        description: "Categorical fit: very_good_fit, good_fit, or bad_fit.",
      },
      reason: {
        type: "string",
        description: "Brief 1-2 sentence explanation of the category.",
      },
    },
    required: ["category", "reason"],
    additionalProperties: false,
  },
};

function isSalaryMissing(salary: string | null): boolean {
  return salary === null || salary.trim() === "";
}

const RANK_TO_CATEGORY: Record<number, SuitabilityCategory> = {
  0: "bad_fit",
  1: "good_fit",
  2: "very_good_fit",
};

function demoteOneTier(category: SuitabilityCategory): SuitabilityCategory {
  const rank = SUITABILITY_CATEGORY_RANK[category];
  if (rank <= 0) return "bad_fit";
  return RANK_TO_CATEGORY[rank - 1];
}

function applySalaryPenalty(
  job: Job,
  category: SuitabilityCategory,
  reason: string,
  settings: { penalizeMissingSalary: boolean },
): SuitabilityResult {
  if (!settings.penalizeMissingSalary || !isSalaryMissing(job.salary)) {
    return { category, reason };
  }
  const demoted = demoteOneTier(category);
  if (demoted === category) return { category, reason };
  const note = "Demoted one tier due to missing salary information.";
  logger.info("Applied salary penalty", {
    jobId: job.id,
    originalCategory: category,
    demotedCategory: demoted,
  });
  return { category: demoted, reason: `${reason} ${note}` };
}

function isSuitabilityCategory(value: unknown): value is SuitabilityCategory {
  return (
    typeof value === "string" &&
    (SUITABILITY_CATEGORIES as readonly string[]).includes(value)
  );
}

export async function scoreJobSuitability(
  job: Job,
  brief: string,
): Promise<SuitabilityResult> {
  const descriptionLength = (job.jobDescription ?? "").trim().length;
  if (descriptionLength < MIN_SCOREABLE_DESCRIPTION_CHARS) {
    throw new JobNotScoreableError({
      jobId: job.id,
      observed: descriptionLength,
      required: MIN_SCOREABLE_DESCRIPTION_CHARS,
    });
  }

  const [model, settings] = await Promise.all([
    resolveLlmModel("scoring"),
    getEffectiveSettings(),
  ]);

  const prompt = await buildScoringPrompt(job, brief.trim(), {
    instructions: settings.scoringInstructions?.value ?? "",
  });

  const llm = new LlmService();
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (prompt.system) {
    messages.push({ role: "system", content: prompt.system });
  }
  messages.push({ role: "user", content: prompt.user });

  const result = await llm.callJson<{ category: unknown; reason: unknown }>({
    model,
    messages,
    jsonSchema: SCORING_SCHEMA,
    maxRetries: 2,
    jobId: job.id,
    label: "score job",
    subject: `${job.title} @ ${job.employer}`,
  });

  if (!result.success) {
    if (result.error.toLowerCase().includes("api key")) {
      logger.warn("LLM API key not set, using mock scoring", { jobId: job.id });
    }
    logger.error("Scoring failed, using mock scoring", {
      jobId: job.id,
      error: result.error,
    });
    return mockScore(job, {
      penalizeMissingSalary: settings.penalizeMissingSalary.value,
    });
  }

  const { category: rawCategory, reason: rawReason } = result.data;

  if (!isSuitabilityCategory(rawCategory)) {
    logger.error("Invalid category in AI response, using mock scoring", {
      jobId: job.id,
      rawCategory,
    });
    return mockScore(job, {
      penalizeMissingSalary: settings.penalizeMissingSalary.value,
    });
  }

  const reason =
    typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.trim()
      : "No explanation provided";

  return applySalaryPenalty(job, rawCategory, reason, {
    penalizeMissingSalary: settings.penalizeMissingSalary.value,
  });
}

async function buildScoringPrompt(
  job: Job,
  briefText: string,
  preferences: ScoringPreferences,
): Promise<{ system: string; user: string }> {
  const loaded = await loadPrompt("job-score", {
    briefText: briefText || "No personal brief provided.",
    jobTitle: job.title,
    employer: job.employer,
    location: job.location || "Not specified",
    salary: job.salary || "Not specified",
    degreeRequired: job.degreeRequired || "Not specified",
    disciplines: job.disciplines || "Not specified",
    jobDescription: job.jobDescription || "No description available",
    // The prompt is a structural shell; the instructions ARE the scoring
    // policy, so an empty value must fall back to the shipped policy — a
    // bare shell would leave the model no category semantics at all.
    scoringInstructionsText: preferences.instructions
      ? preferences.instructions
      : DEFAULT_SCORING_INSTRUCTIONS,
  });
  return { system: loaded.system, user: loaded.user };
}

async function mockScore(
  job: Job,
  settings: { penalizeMissingSalary: boolean },
): Promise<SuitabilityResult> {
  const jd = (job.jobDescription || "").toLowerCase();
  const title = job.title.toLowerCase();

  const goodKeywords = [
    "typescript",
    "react",
    "node",
    "python",
    "web",
    "frontend",
    "backend",
    "fullstack",
    "software",
    "engineer",
    "developer",
  ];
  const badKeywords = [
    "senior",
    "5+ years",
    "10+ years",
    "principal",
    "staff",
    "manager",
  ];

  let goodHits = 0;
  let badHits = 0;
  for (const kw of goodKeywords) {
    if (jd.includes(kw) || title.includes(kw)) goodHits += 1;
  }
  for (const kw of badKeywords) {
    if (jd.includes(kw) || title.includes(kw)) badHits += 1;
  }

  const heuristic: SuitabilityCategory =
    goodHits >= 4 && badHits === 0
      ? "very_good_fit"
      : goodHits >= 2 && badHits <= 1
        ? "good_fit"
        : "bad_fit";

  const baseReason = "Scored using keyword matching (API key not configured)";

  return applySalaryPenalty(job, heuristic, baseReason, settings);
}

/**
 * Score multiple jobs and return sorted by category rank (best first), with
 * `discoveredAt` desc as the tiebreaker.
 */
export async function scoreAndRankJobs(
  jobs: Job[],
  brief: string,
): Promise<
  Array<
    Job & {
      suitabilityCategory: SuitabilityCategory;
      suitabilityReason: string;
    }
  >
> {
  const scoredJobs = await Promise.all(
    jobs.map(async (job) => {
      const { category, reason } = await scoreJobSuitability(job, brief);
      return {
        ...job,
        suitabilityCategory: category,
        suitabilityReason: reason,
      };
    }),
  );

  return scoredJobs.sort((a, b) => {
    const rankDiff =
      SUITABILITY_CATEGORY_RANK[b.suitabilityCategory] -
      SUITABILITY_CATEGORY_RANK[a.suitabilityCategory];
    if (rankDiff !== 0) return rankDiff;
    return b.discoveredAt.localeCompare(a.discoveredAt);
  });
}
