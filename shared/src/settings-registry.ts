import { z } from "zod";
import { SUITABILITY_CATEGORIES, type SuitabilityCategory } from "./types/jobs";
import {
  CHAT_STYLE_LANGUAGE_MODE_VALUES,
  CHAT_STYLE_MANUAL_LANGUAGE_VALUES,
  type ChatStyleLanguageMode,
  type ChatStyleManualLanguage,
} from "./types/settings";

function parseNonEmptyStringOrNull(raw: string | undefined): string | null {
  return raw === undefined || raw === "" ? null : raw;
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// The one ceiling every concurrency layer shares: the asyncPool hard clamp,
// the five pool-width setting schemas, the read-path clamp below, and the
// Settings form all mirror this constant. It is deliberately far above any
// useful width for API-backed LLM pools — its job is not tuning but blast
// containment: under the claude_code provider every pooled task is a spawned
// CLI subprocess (and batch URL import multiplies pages inside the shared
// Camoufox browser), so an unbounded fat-fingered value would fork-bomb the
// container. The upstream fork shipped 10 with no recorded reasoning; raised
// to 100 on 2026-08-10.
export const MAX_POOL_CONCURRENCY = 100;

// Clamps to the same 1..MAX_POOL_CONCURRENCY the concurrency schemas enforce,
// so an out-of-band stored value (hand-edited DB row, crafted snapshot) can
// never stall a pool at 0 or overshoot the asyncPool clamp on read.
function parseConcurrencyOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed)
    ? null
    : Math.min(MAX_POOL_CONCURRENCY, Math.max(1, parsed));
}

function parseBitBoolOrNull(raw: string | undefined): boolean | null {
  if (!raw) return null;
  return raw === "true" || raw === "1";
}

function normalizeLlmProviderOrNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
  return normalized ? normalized : null;
}

export const DEFAULT_GEMINI_MODEL = "google/gemini-3-flash-preview";
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
export const DEFAULT_CODEX_MODEL = "";
// Empty means "let the Claude Code CLI pick its own default" — the same
// contract as Codex, so no model id is pinned here to rot.
export const DEFAULT_CLAUDE_CODE_MODEL = "";

/**
 * Every LLM provider the app can talk to. One list, because it is now consumed
 * by more than the provider setting: the benchmark validates a per-column
 * provider against it, and the client's label/hint tables key off it.
 */
export const LLM_PROVIDER_IDS = [
  "openrouter",
  "lmstudio",
  "ollama",
  "openai",
  "openai_compatible",
  "gemini",
  "codex",
  "claude_code",
] as const;
export type LlmProviderIdValue = (typeof LLM_PROVIDER_IDS)[number];

// Accepted values of the Claude Code CLI's `--effort` flag (verified against
// v2.1.220 and v2.1.226 — an unknown value only warns and falls back to the
// CLI default, so a future CLI changing this list degrades gracefully).
export const CLAUDE_CODE_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ClaudeCodeEffortLevel = (typeof CLAUDE_CODE_EFFORT_LEVELS)[number];

export function getDefaultModelForProvider(
  provider: string | null | undefined,
  fallbackModel?: string | null,
): string {
  const trimmedFallback = fallbackModel?.trim();
  if (trimmedFallback) {
    return trimmedFallback;
  }

  const normalizedProvider = normalizeLlmProviderOrNull(provider ?? undefined);

  if (normalizedProvider === "openai") {
    return DEFAULT_OPENAI_MODEL;
  }

  if (normalizedProvider === "gemini") {
    return DEFAULT_GEMINI_MODEL;
  }

  if (normalizedProvider === "codex") {
    return DEFAULT_CODEX_MODEL;
  }

  if (normalizedProvider === "claude_code") {
    return DEFAULT_CLAUDE_CODE_MODEL;
  }
  return DEFAULT_GEMINI_MODEL;
}

function serializeNullableNumber(
  value: number | null | undefined,
): string | null {
  return value !== null && value !== undefined ? String(value) : null;
}

function serializeBitBool(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value ? "1" : "0";
}

function createEnumParser<const TValues extends readonly [string, ...string[]]>(
  values: TValues,
): (raw: string | undefined) => TValues[number] | null {
  const allowedValues = new Set<string>(values);

  return (raw: string | undefined): TValues[number] | null => {
    if (!raw) return null;
    return allowedValues.has(raw) ? (raw as TValues[number]) : null;
  };
}

const parseChatStyleLanguageModeOrNull = createEnumParser(
  CHAT_STYLE_LANGUAGE_MODE_VALUES,
);

// The COMPLETE scoring policy for the job scorer — category semantics, gates,
// and calibration examples. The job-score prompt is a structural shell (inputs
// + JSON contract) and injects this wholesale via {{scoringInstructionsText}};
// a stored scoringInstructions override replaces it entirely, so this text is
// the single home of scoring behavior. It rides into every scoring call — keep
// it dense. Must stay trim-stable (no edge whitespace): the client save path
// compares the trimmed field against this constant to decide override-vs-default.
export const DEFAULT_SCORING_INSTRUCTIONS = `Decide as a recruiter: would this candidate clearly be shortlisted? They need not be the perfect applicant — direct coverage of the core with no missing differentiator is a clear shortlist.

Separate the job's requirements into two groups:
- CORE: the discipline and stack the role is actually about, plus explicit mandatory qualifications or experience thresholds in it. These are gates.
- SECONDARY: everything else — tools, cloud vendors, industry/domain exposure, specific modalities, "desirable" items. Missing several of these is normal and never blocks very_good_fit.

A DIFFERENTIATOR is a capability the ad emphasizes as what distinguishes the wanted candidate — headlined, repeated, or demanded as demonstrable ("proven delivery of X"). Do not promote secondary items into differentiators to justify a demotion.

Venue neutrality: research, academic, and open-source work is DIRECT evidence of a discipline, equal to commercial experience. Never demote for an academic background, for "professional/commercial environment" phrasing, or for lacking the employer's industry exposure. Sole exception: when the ad explicitly demands a delivered commercial/product track record of a specific deliverable, academic-only versions of that deliverable cap the job at good_fit.

Categories:
- great_fit: the role reads as written for the candidate. Everything very_good_fit requires, plus most of the ad's desirable items are also met with direct evidence, and the role matches the candidate's stated target roles and preferences. Reserve it for roles where the candidate is truly among the strongest plausible applicants.
- very_good_fit: clear shortlist. Direct, demonstrated experience on the core requirements at the right level, and no explicitly demanded differentiator is absent.
- good_fit: a fair shot — worth an application. The core discipline is practiced with direct evidence, but the level is a modest stretch, an explicitly demanded differentiator is missing, or a core experience threshold falls slightly short in a discipline the candidate genuinely practices.
- bad_fit: the core discipline is not one the candidate has actually practiced (adjacent skills do not substitute); or a mandatory qualification or experience threshold in it is clearly unmet; or a hard blocker exists (required language, clearance, credential, or a veto rule in the candidate's brief).

Transferable or adjacent experience satisfies SECONDARY requirements only; for CORE requirements it never lifts a job past good_fit. Keyword overlap is not fit: a role in a different specialty that shares the candidate's tools is still bad_fit. When torn between categories, decide from the concrete evidence above — do not invent a hypothetical stronger applicant pool to demote against.

Calibration examples (real verdicts, corrected by the user):
- Ad: enterprise ETL/DWH engineer — 10+ years ETL/DWH, Spark/Databricks at its core. Brief: TB-scale research data pipelines, strong Python/SQL, never an ETL/DWH developer -> bad_fit. Adjacent pipeline skill does not substitute for an unpracticed core discipline.
- Ad: ML engineer explicitly demanding demonstrable delivery of multiple production time-series forecasting projects. Brief: strong ML/statistical modeling, academic time-series work, production deployment skills — but no delivered forecasting projects -> good_fit. The explicitly demanded differentiator is absent; still worth applying.
- Ad: commercial data scientist — core is statistical/ML modeling with Python/SQL; insurance domain and Azure/Databricks listed as desirable. Brief: PhD-level statistical modeling on messy real-world data plus TB-scale production pipelines, all from academia -> very_good_fit, not great_fit. The core is practiced directly and the academic venue is not a demotion, but the desirables are not covered.
- Ad: university research data scientist embedded with academic teams. Brief: PhD computational scientist with a cross-disciplinary research record, covering the desirables and matching the candidate's stated target roles -> great_fit. The role reads as written for the candidate.`;

const parseChatStyleManualLanguageOrNull = createEnumParser(
  CHAT_STYLE_MANUAL_LANGUAGE_VALUES,
);

export const settingsRegistry = {
  // --- Typed Settings ---
  model: {
    kind: "typed" as const,
    schema: z.string().trim().max(200),
    default: (): string =>
      typeof process !== "undefined"
        ? getDefaultModelForProvider(
            process.env.LLM_PROVIDER,
            process.env.MODEL,
          )
        : DEFAULT_GEMINI_MODEL,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmProvider: {
    kind: "typed" as const,
    envKey: "LLM_PROVIDER",
    schema: z.preprocess(
      (v) => (typeof v === "string" ? normalizeLlmProviderOrNull(v) : v),
      z.enum(LLM_PROVIDER_IDS).nullable(),
    ),
    default: (): string =>
      typeof process !== "undefined"
        ? normalizeLlmProviderOrNull(process.env.LLM_PROVIDER) || "openrouter"
        : "openrouter",
    parse: normalizeLlmProviderOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmBaseUrl: {
    kind: "typed" as const,
    envKey: "LLM_BASE_URL",
    schema: z.preprocess(
      (v) => (v === "" ? null : v),
      z.string().trim().url().max(2000).nullable(),
    ),
    default: (): string =>
      typeof process !== "undefined" ? process.env.LLM_BASE_URL || "" : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  scoringInstructions: {
    kind: "typed" as const,
    // The full scoring policy lives here (~4.1k chars shipped); 16k leaves
    // room for the user to grow the calibration-example list several-fold
    // without letting a runaway paste bloat every scoring call unnoticed.
    schema: z.string().trim().max(16000),
    default: (): string => DEFAULT_SCORING_INSTRUCTIONS,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  // ghostwriterSystemPromptTemplate, tailoringPromptTemplate, scoringPromptTemplate
  // were removed — all LLM prompts now live in user-editable YAML under prompts/.
  showSponsorInfo: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  renderMarkdownInJobDescriptions: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  chatStyleTone: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_TONE || "professional"
        : "professional",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleFormality: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_FORMALITY || "medium"
        : "medium",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleConstraints: {
    kind: "typed" as const,
    schema: z.string().trim().max(4000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_CONSTRAINTS || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleDoNotUse: {
    kind: "typed" as const,
    schema: z.string().trim().max(1000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_DO_NOT_USE || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleSummaryMaxWords: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(500).nullable(),
    default: (): number | null => null,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  chatStyleMaxKeywordsPerSkill: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(50).nullable(),
    default: (): number | null => null,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  chatStyleLanguageMode: {
    kind: "typed" as const,
    schema: z.enum(CHAT_STYLE_LANGUAGE_MODE_VALUES),
    default: (): ChatStyleLanguageMode =>
      parseChatStyleLanguageModeOrNull(
        typeof process !== "undefined"
          ? process.env.CHAT_STYLE_LANGUAGE_MODE
          : undefined,
      ) ?? "manual",
    parse: parseChatStyleLanguageModeOrNull,
    serialize: (
      value: ChatStyleLanguageMode | null | undefined,
    ): string | null => value ?? null,
  },
  chatStyleManualLanguage: {
    kind: "typed" as const,
    schema: z.enum(CHAT_STYLE_MANUAL_LANGUAGE_VALUES),
    default: (): ChatStyleManualLanguage =>
      parseChatStyleManualLanguageOrNull(
        typeof process !== "undefined"
          ? process.env.CHAT_STYLE_MANUAL_LANGUAGE
          : undefined,
      ) ?? "english",
    parse: parseChatStyleManualLanguageOrNull,
    serialize: (
      value: ChatStyleManualLanguage | null | undefined,
    ): string | null => value ?? null,
  },
  penalizeMissingSalary: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => {
      if (typeof process === "undefined") return false;
      const v = process.env.PENALIZE_MISSING_SALARY || "0";
      return v === "1" || v.toLowerCase() === "true";
    },
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  missingSalaryPenalty: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number => {
      if (typeof process === "undefined") return 10;
      const raw = process.env.MISSING_SALARY_PENALTY;
      if (!raw) return 10;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? 10 : Math.min(100, Math.max(0, parsed));
    },
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  minSuitabilityCategory: {
    kind: "typed" as const,
    schema: z.enum(SUITABILITY_CATEGORIES),
    default: (): SuitabilityCategory => "good_fit",
    parse: (raw: string | undefined): SuitabilityCategory | null => {
      if (!raw) return null;
      return (SUITABILITY_CATEGORIES as readonly string[]).includes(raw)
        ? (raw as SuitabilityCategory)
        : null;
    },
    serialize: (value: SuitabilityCategory | null | undefined): string | null =>
      value ?? null,
  },
  autoSkipCategory: {
    kind: "typed" as const,
    schema: z.enum(SUITABILITY_CATEGORIES),
    default: (): SuitabilityCategory | null => null,
    parse: (raw: string | undefined): SuitabilityCategory | null => {
      if (!raw || raw === "null" || raw === "") return null;
      return (SUITABILITY_CATEGORIES as readonly string[]).includes(raw)
        ? (raw as SuitabilityCategory)
        : null;
    },
    serialize: (value: SuitabilityCategory | null | undefined): string | null =>
      value ?? null,
  },
  autoTailoringEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  enableJobScoring: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  inboxStaleThresholdDays: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(365),
    default: (): number => 7,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isNaN(parsed) ? null : Math.min(365, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  maxBulkActionJobs: {
    kind: "typed" as const,
    schema: z.number().int().min(1),
    default: (): number => 1000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  // --- Concurrency limits (Pipeline section) ---
  // The max mirrors asyncPool's hard clamp by construction — both sides
  // derive from MAX_POOL_CONCURRENCY (see its comment for why a ceiling
  // exists at all), so a saved value can never silently exceed what applies.
  discoveryConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(MAX_POOL_CONCURRENCY),
    default: (): number => 3,
    parse: parseConcurrencyOrNull,
    serialize: serializeNullableNumber,
  },
  // How many times a provider rate limit may be retried GLOBALLY (across every
  // LLM call, not per call) before all LLM work stops. Small on purpose: the
  // failure this guards is a session/quota limit that resets on the order of
  // hours, so extra attempts buy nothing and each costs a full round trip —
  // 3 rides out a transient per-minute 429 while stopping fast on a hard stop.
  // 0 means stop at the first rate limit. The ceiling mirrors the pool cap: a
  // blast-containment number, not a tuning one.
  llmRateLimitRetries: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(MAX_POOL_CONCURRENCY),
    default: (): number => 3,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  scoringConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(MAX_POOL_CONCURRENCY),
    default: (): number => 4,
    parse: parseConcurrencyOrNull,
    serialize: serializeNullableNumber,
  },
  tailoringConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(MAX_POOL_CONCURRENCY),
    default: (): number => 3,
    parse: parseConcurrencyOrNull,
    serialize: serializeNullableNumber,
  },
  bulkActionConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(MAX_POOL_CONCURRENCY),
    default: (): number => 4,
    parse: parseConcurrencyOrNull,
    serialize: serializeNullableNumber,
  },
  batchUrlImportConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(MAX_POOL_CONCURRENCY),
    default: (): number => 3,
    parse: parseConcurrencyOrNull,
    serialize: serializeNullableNumber,
  },
  // --- Context limits (LLM-bound character caps) ---
  // Enforced at the write boundary; exceeding a cap returns 422 with the
  // observed length rather than silently truncating into the prompt.
  maxBriefChars: {
    kind: "typed" as const,
    schema: z.number().int().min(1000).max(1_000_000),
    default: (): number => 200_000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  maxJobDescriptionChars: {
    kind: "typed" as const,
    schema: z.number().int().min(1000).max(1_000_000),
    default: (): number => 100_000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  maxTailoredContentChars: {
    kind: "typed" as const,
    schema: z.number().int().min(1000).max(1_000_000),
    default: (): number => 100_000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  maxCoverLetterChars: {
    kind: "typed" as const,
    schema: z.number().int().min(1000).max(1_000_000),
    default: (): number => 50_000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  maxFetchedJobHtmlChars: {
    kind: "typed" as const,
    schema: z.number().int().min(10_000).max(5_000_000),
    default: (): number => 500_000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  manualJobFetchTimeoutMs: {
    kind: "typed" as const,
    schema: z.number().int().min(1_000).max(120_000),
    default: (): number => 15_000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  manualJobFetchMinExtractedChars: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100_000),
    default: (): number => 200,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  manualJobFetchBrowserSettleMs: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(60_000),
    default: (): number => 5_000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  maxExtractionPromptChars: {
    kind: "typed" as const,
    schema: z.number().int().min(1000).max(1_000_000),
    default: (): number => 100_000,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },

  // --- File-IO byte caps (Pipeline section) ---
  maxCvUploadBytes: {
    kind: "typed" as const,
    schema: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(500 * 1024 * 1024),
    default: (): number => 50 * 1024 * 1024,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  maxCoverLetterUploadBytes: {
    kind: "typed" as const,
    schema: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(500 * 1024 * 1024),
    default: (): number => 50 * 1024 * 1024,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  maxExpandedLatexBytes: {
    kind: "typed" as const,
    schema: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(500 * 1024 * 1024),
    default: (): number => 50 * 1024 * 1024,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },

  // --- Model Variants ---
  modelScorer: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },
  modelTailoring: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },

  // --- Auth / session ---
  // Session-token lifetime. Default is deliberately null (= jwt.ts's built-in
  // 86400s fallback), NOT read from process.env: applyStoredEnvOverrides
  // writes the DB override into process.env at boot, so an env-reading
  // default() would echo the override back as the default and break the
  // client's nullIfSame collapse (the llmBaseUrl trap). The JWT_EXPIRY_SECONDS
  // env var stays an invisible baseline; a DB override wins over it.
  jwtExpirySeconds: {
    kind: "typed" as const,
    envKey: "JWT_EXPIRY_SECONDS",
    schema: z.number().int().min(60).max(31536000).nullable(),
    default: (): number | null => null,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },

  // --- Simple Strings ---
  // Server-managed pointer to the default Profile. Set via the profiles
  // set-default / delete routes, not the Settings UI, so it's a plain
  // nullable string (like onboardingBasicAuthDecision) rather than a Resolved.
  defaultProfileId: {
    kind: "string" as const,
    schema: z.string().trim().max(100),
  },
  // Server-managed self-identity of this database ("user profile" = a whole
  // DB). Set by the user-profiles routes and a migrate seed, never the
  // Settings form.
  userProfileName: {
    kind: "string" as const,
    schema: z.string().trim().min(1).max(200),
  },
  onboardingBasicAuthDecision: {
    kind: "string" as const,
    schema: z.enum(["enabled", "skipped"]),
  },
  // Server-managed, IMMUTABLE per User Profile: the CV substrate format,
  // written once by the onboarding wizard and then frozen by the write-once
  // guard in services/settings-update/registry.ts (the generic settings
  // PATCH can otherwise write every registry key). Unset = effective
  // "latex", which also makes every pre-feature DB correctly LaTeX.
  cvSourceFormat: {
    kind: "string" as const,
    schema: z.enum(["latex", "docx"]),
  },
  // Reasoning-effort level passed to the Claude Code CLI as `--effort` on
  // every call (claude_code provider only). Unset means the CLI's own default.
  // envKey machinery syncs the stored value into process.env, where the
  // subprocess spawner reads it at call time — the same knob shape as
  // CLAUDE_CODE_BIN and the timeout envs.
  claudeCodeEffort: {
    kind: "string" as const,
    envKey: "CLAUDE_CODE_EFFORT",
    schema: z.enum(CLAUDE_CODE_EFFORT_LEVELS),
  },
  basicAuthUser: {
    kind: "string" as const,
    envKey: "BASIC_AUTH_USER",
    schema: z.string().trim().max(200),
  },

  // --- Secrets ---
  llmApiKey: {
    kind: "secret" as const,
    envKey: "LLM_API_KEY",
    schema: z.string().trim().max(2000),
  },
  basicAuthPassword: {
    kind: "secret" as const,
    envKey: "BASIC_AUTH_PASSWORD",
    schema: z.string().trim().max(2000),
  },
  apifyApiToken: {
    kind: "secret" as const,
    envKey: "APIFY_API_TOKEN",
    schema: z.string().trim().max(2000),
  },
  // Deliberately its OWN key rather than reusing llmApiKey: the Claude Code
  // provider spawns a CLI that reads CLAUDE_CODE_OAUTH_TOKEN from its own
  // environment, and the envKey machinery syncs this value into process.env at
  // boot and on save. Sharing llmApiKey would let a stale key from a previously
  // configured provider silently shadow a working ambient token.
  claudeCodeOauthToken: {
    kind: "secret" as const,
    envKey: "CLAUDE_CODE_OAUTH_TOKEN",
    schema: z.string().trim().max(2000),
  },

  // --- Virtual ---
  enableBasicAuth: {
    kind: "virtual" as const,
    schema: z.boolean(),
  },
} as const;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingsRegistryKey = keyof SettingsRegistry;

/**
 * Registry keys flagged `kind: "secret"` (LLM/Apify credentials, basic-auth
 * password). Used by the DB-export path to strip credential values when the
 * user opts out of including secrets in a backup.
 */
export const SECRET_SETTING_KEYS = (
  Object.keys(settingsRegistry) as SettingsRegistryKey[]
).filter((key) => settingsRegistry[key].kind === "secret");
