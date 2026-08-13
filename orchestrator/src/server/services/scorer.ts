/**
 * Service for scoring job suitability using AI.
 *
 * Emits a categorical suitability assessment (`great_fit | very_good_fit |
 * good_fit | bad_fit`) instead of a 0-100 numeric score. The "missing salary" penalty
 * (when enabled) demotes the category by one tier so a great-on-paper match
 * with no salary disclosure surfaces below other comparable matches.
 */

import { AppError } from "@infra/errors";
import { logger } from "@infra/logger";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  type ClaudeCodeEffortLevel,
  DEFAULT_SCORING_INSTRUCTIONS,
} from "@shared/settings-registry";
import {
  type Job,
  SUITABILITY_CATEGORIES,
  SUITABILITY_CATEGORY_RANK,
  type SuitabilityCategory,
} from "@shared/types";
import { resolveProviderCall } from "./llm/provider-credentials";
import { LlmService } from "./llm/service";
import type {
  JsonSchemaDefinition,
  LlmServiceOptions,
  LlmTokenUsage,
} from "./llm/types";
import { resolveLlmModel } from "./modelSelection";
import { loadPrompt } from "./prompts";
import { getEffectiveSettings } from "./settings";

/**
 * Minimum job-description length below which we refuse to score. Scoring on
 * a title-only listing produces garbage assessments (LLM has nothing to
 * judge against the brief), so we'd rather leave the row unscored and
 * surface the problem.
 */
export const MIN_SCOREABLE_DESCRIPTION_CHARS = 100;

export class JobNotScoreableError extends AppError {
  constructor(args: { jobId: string; observed: number; required: number }) {
    super({
      status: 422,
      code: "UNPROCESSABLE_ENTITY",
      message: `Cannot score job — description is ${args.observed} chars (need ≥ ${args.required}). Re-fetch the URL or paste the full description.`,
      details: {
        jobId: args.jobId,
        observed: args.observed,
        required: args.required,
      },
    });
    this.name = "JobNotScoreableError";
  }
}

/**
 * The provider refused on a rate/session limit and the global retry budget is
 * spent. Distinct from a scoring failure because it is not about this job:
 * nothing will score until the limit resets, so callers must STOP rather than
 * move to the next job.
 */
export class LlmRateLimitStopError extends AppError {
  constructor(args: { jobId: string; reason: string }) {
    super({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: `Scoring stopped — the LLM provider is rate limiting: ${args.reason}`,
      details: { jobId: args.jobId, reason: args.reason },
    });
    this.name = "LlmRateLimitStopError";
  }
}

/**
 * The LLM could not score THIS job (bad response, transient error, no key).
 * The row is left unscored and the run moves on — a job with no score is
 * honest, a fabricated one is not.
 */
export class JobScoringFailedError extends AppError {
  constructor(args: { jobId: string; reason: string }) {
    super({
      status: 502,
      code: "UPSTREAM_ERROR",
      message: `Could not score job: ${args.reason}`,
      details: { jobId: args.jobId, reason: args.reason },
    });
    this.name = "JobScoringFailedError";
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
        description:
          "Categorical fit: great_fit, very_good_fit, good_fit, or bad_fit.",
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
  3: "great_fit",
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

/**
 * One classification call, with the model configuration handed in rather than
 * resolved from settings. This is the whole scoring path EXCEPT the salary
 * penalty: the description gate, the prompt, the LLM call, and the typed
 * failures. `scoreJobSuitability` is this plus the penalty; the model-benchmark
 * runner is this with a caller-chosen model/effort and nothing persisted.
 *
 * The penalty deliberately lives outside: it is deterministic post-processing
 * applied identically whatever the model, so a comparison that included it
 * would only add correlated noise to every column.
 */
export async function classifyJob(
  job: Job,
  brief: string,
  config: {
    model: string;
    instructions: string;
    effort?: ClaudeCodeEffortLevel;
    /**
     * Which provider to call, with its own credentials. Omitted — every caller
     * but the benchmark — resolves from the environment exactly as before.
     */
    llm?: LlmServiceOptions;
  },
): Promise<{
  category: SuitabilityCategory;
  reason: string;
  usage?: LlmTokenUsage;
}> {
  const descriptionLength = (job.jobDescription ?? "").trim().length;
  if (descriptionLength < MIN_SCOREABLE_DESCRIPTION_CHARS) {
    throw new JobNotScoreableError({
      jobId: job.id,
      observed: descriptionLength,
      required: MIN_SCOREABLE_DESCRIPTION_CHARS,
    });
  }

  const prompt = await buildScoringPrompt(job, brief.trim(), {
    instructions: config.instructions,
  });

  const llm = new LlmService(config.llm ?? {});
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (prompt.system) {
    messages.push({ role: "system", content: prompt.system });
  }
  messages.push({ role: "user", content: prompt.user });

  const result = await llm.callJson<{ category: unknown; reason: unknown }>({
    model: config.model,
    messages,
    jsonSchema: SCORING_SCHEMA,
    maxRetries: 2,
    jobId: job.id,
    label: "score job",
    subject: `${job.title} @ ${job.employer}`,
    ...(config.effort ? { effort: config.effort } : {}),
  });

  if (!result.success) {
    // A rate limit is global and temporary: every other queued job is about to
    // hit the same wall, so stop instead of failing one job at a time.
    if (result.code === "rate_limited") {
      throw new LlmRateLimitStopError({ jobId: job.id, reason: result.error });
    }
    logger.error("Scoring failed, leaving job unscored", {
      jobId: job.id,
      code: result.code,
      error: result.error,
    });
    throw new JobScoringFailedError({ jobId: job.id, reason: result.error });
  }

  const { category: rawCategory, reason: rawReason } = result.data;

  if (!isSuitabilityCategory(rawCategory)) {
    logger.error("Invalid category in AI response, leaving job unscored", {
      jobId: job.id,
      rawCategory,
    });
    throw new JobScoringFailedError({
      jobId: job.id,
      reason: `LLM returned an unrecognised category: ${String(rawCategory)}`,
    });
  }

  const reason =
    typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.trim()
      : "No explanation provided";

  return { category: rawCategory, reason, usage: result.usage };
}

/**
 * Note appended to a category the cheap screen decided on its own. The salary
 * penalty already writes into `reason` the same way, so this needs no column —
 * and without it a `bad_fit` from a screen is indistinguishable from one the
 * good model actually looked at.
 */
function prefilterNote(model: string): string {
  return `Screened out by the pre-filter model (${model}); the main model did not review this job.`;
}

export async function scoreJobSuitability(
  job: Job,
  brief: string,
  options?: {
    /**
     * Opt IN to the cheap pre-filter. Only the pipeline's scoring step does,
     * for the same reason only it auto-skips: it is the path that classifies
     * everything the scrapers find, and the screen can only ever REMOVE a job.
     * Every user-initiated request — Recalculate match, a rescrape, a pasted
     * URL — goes straight to the main model, which is also what makes them a
     * reliable second opinion on anything the screen killed.
     *
     * Opt-in rather than opt-out on purpose: a new caller that forgets this
     * gets the good model, not a silent screen.
     */
    prefilter?: boolean;
  },
): Promise<SuitabilityResult> {
  // Re-checked here, ahead of the settings reads, purely to keep an unscoreable
  // job as cheap as it was before `classifyJob` was split out — a batch of them
  // would otherwise pay two settings reads each before being rejected.
  // `classifyJob` checks it again; the gate is idempotent.
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
  const instructions = settings.scoringInstructions?.value ?? "";
  const penalty = {
    penalizeMissingSalary: settings.penalizeMissingSalary.value,
  };

  const screen = options?.prefilter
    ? await resolvePrefilter(settings, model)
    : null;

  if (screen) {
    try {
      const first = await classifyJob(job, brief, {
        model: screen.model,
        instructions,
        ...(screen.effort ? { effort: screen.effort } : {}),
        llm: screen.llm,
      });
      logger.info("Pre-filter classified job", {
        jobId: job.id,
        provider: screen.llm.provider ?? null,
        model: screen.model,
        category: first.category,
        forwarded: first.category !== "bad_fit",
      });
      // The screen's ONLY power: stop here on bad_fit. Anything else is
      // discarded — the good model re-classifies from scratch and its answer
      // wins outright, so a generous screen costs money and never accuracy.
      if (first.category === "bad_fit") {
        return applySalaryPenalty(
          job,
          first.category,
          `${first.reason} ${prefilterNote(screen.model)}`,
          penalty,
        );
      }
    } catch (error) {
      // Fail OPEN. A rate limit is account-wide and the second call would hit
      // the same wall, so it propagates; anything else means the screen is
      // broken, and a broken screen must never delete jobs.
      if (error instanceof LlmRateLimitStopError) throw error;
      logger.warn("Pre-filter failed; falling through to the main model", {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const { category, reason } = await classifyJob(job, brief, {
    model,
    instructions,
  });

  return applySalaryPenalty(job, category, reason, penalty);
}

/**
 * The screen's resolved configuration, or null when it is off — an empty model,
 * or one that resolves to the very same provider/model/effort as the main call,
 * which would just pay twice for one answer.
 */
async function resolvePrefilter(
  settings: Awaited<ReturnType<typeof getEffectiveSettings>>,
  mainModel: string,
): Promise<{
  model: string;
  effort: ClaudeCodeEffortLevel | null;
  llm: LlmServiceOptions;
} | null> {
  const model = settings.scorerPrefilterModel?.value?.trim() ?? "";
  if (!model) return null;

  const resolved = await resolveProviderCall(
    settings.scorerPrefilterProvider?.value ?? null,
  );
  if (resolved.missingReason) {
    // Configured but unusable: log once per call rather than failing the job,
    // since the main model is about to answer anyway.
    logger.warn("Pre-filter has no usable credential; skipping it", {
      provider: resolved.provider,
      reason: resolved.missingReason,
    });
    return null;
  }

  const effort =
    resolved.provider === "claude_code"
      ? parseEffortLevel(settings.scorerPrefilterEffort?.value)
      : null;

  const activeProvider = normalizeProviderValue(settings.llmProvider?.value);
  const sameProvider =
    settings.scorerPrefilterProvider?.value == null ||
    resolved.provider === activeProvider;
  if (sameProvider && model === mainModel && effort === null) {
    return null;
  }

  return { model, effort, llm: resolved.options };
}

function parseEffortLevel(value: unknown): ClaudeCodeEffortLevel | null {
  return typeof value === "string" &&
    (CLAUDE_CODE_EFFORT_LEVELS as readonly string[]).includes(value)
    ? (value as ClaudeCodeEffortLevel)
    : null;
}

function normalizeProviderValue(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase().replace(/-/g, "_")
    : null;
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
