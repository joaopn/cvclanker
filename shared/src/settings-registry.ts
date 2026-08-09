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

// Clamps to the same 1..10 the concurrency schemas enforce, so an
// out-of-band stored value (hand-edited DB row, crafted snapshot) can never
// stall a pool at 0 or overshoot the asyncPool clamp on read.
function parseConcurrencyOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : Math.min(10, Math.max(1, parsed));
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
      z
        .enum([
          "openrouter",
          "lmstudio",
          "ollama",
          "openai",
          "openai_compatible",
          "gemini",
          "codex",
          "claude_code",
        ])
        .nullable(),
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
    schema: z.string().trim().max(4000),
    default: (): string => "",
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
  // Max 10 mirrors the hard clamp in orchestrator utils/async-pool.ts — a
  // higher value would silently not apply there, so the schema keeps the UI
  // honest. Raise both together or not at all.
  discoveryConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(10),
    default: (): number => 3,
    parse: parseConcurrencyOrNull,
    serialize: serializeNullableNumber,
  },
  scoringConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(10),
    default: (): number => 4,
    parse: parseConcurrencyOrNull,
    serialize: serializeNullableNumber,
  },
  tailoringConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(10),
    default: (): number => 3,
    parse: parseConcurrencyOrNull,
    serialize: serializeNullableNumber,
  },
  bulkActionConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(10),
    default: (): number => 4,
    parse: parseConcurrencyOrNull,
    serialize: serializeNullableNumber,
  },
  batchUrlImportConcurrency: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(10),
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
