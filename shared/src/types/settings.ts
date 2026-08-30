import type { SuitabilityCategory } from "./jobs";

export const CHAT_STYLE_LANGUAGE_MODE_VALUES = [
  "manual",
  "match-resume",
] as const;

export type ChatStyleLanguageMode =
  (typeof CHAT_STYLE_LANGUAGE_MODE_VALUES)[number];

export const CHAT_STYLE_MANUAL_LANGUAGE_VALUES = [
  "english",
  "german",
  "french",
  "spanish",
] as const;

export type ChatStyleManualLanguage =
  (typeof CHAT_STYLE_MANUAL_LANGUAGE_VALUES)[number];

export const CHAT_STYLE_MANUAL_LANGUAGE_LABELS: Record<
  ChatStyleManualLanguage,
  string
> = {
  english: "English",
  german: "German",
  french: "French",
  spanish: "Spanish",
};

export interface ValidationResult {
  valid: boolean;
  message: string | null;
  status?: number | null;
}

export interface SearchTermsSuggestionResponse {
  terms: string[];
  source: "ai" | "fallback";
}

export interface DemoInfoResponse {
  demoMode: boolean;
  resetCadenceHours: number;
  lastResetAt: string | null;
  nextResetAt: string | null;
  baselineVersion: string | null;
  baselineName: string | null;
}

export type CvSourceFormat = "latex" | "docx";

export type Resolved<T> = { value: T; default: T; override: T | null };
export type ModelResolved = { value: string; override: string | null };

export interface AppSettings {
  // Typed settings (Resolved):
  model: Resolved<string>;
  llmProvider: Resolved<string>;
  llmBaseUrl: Resolved<string>;
  scoringInstructions: Resolved<string>;
  showSponsorInfo: Resolved<boolean>;
  renderMarkdownInJobDescriptions: Resolved<boolean>;
  chatStyleTone: Resolved<string>;
  chatStyleFormality: Resolved<string>;
  chatStyleConstraints: Resolved<string>;
  chatStyleDoNotUse: Resolved<string>;
  chatStyleLanguageMode: Resolved<ChatStyleLanguageMode>;
  chatStyleManualLanguage: Resolved<ChatStyleManualLanguage>;
  chatStyleSummaryMaxWords: Resolved<number | null>;
  chatStyleMaxKeywordsPerSkill: Resolved<number | null>;
  penalizeMissingSalary: Resolved<boolean>;
  missingSalaryPenalty: Resolved<number>;
  minSuitabilityCategory: Resolved<SuitabilityCategory>;
  autoSkipCategory: Resolved<SuitabilityCategory | null>;
  autoTailoringEnabled: Resolved<boolean>;
  enableJobScoring: Resolved<boolean>;
  liveStatusRefreshEnabled: Resolved<boolean>;
  liveStatusRefreshLimit: Resolved<number>;
  jwtExpirySeconds: Resolved<number | null>;
  inboxStaleThresholdDays: Resolved<number>;
  maxBulkActionJobs: Resolved<number>;
  discoveryConcurrency: Resolved<number>;
  llmRateLimitRetries: Resolved<number>;
  llmRequestTimeoutMs: Resolved<number>;
  latexCompileTimeoutMs: Resolved<number>;
  scoringConcurrency: Resolved<number>;
  tailoringConcurrency: Resolved<number>;
  bulkActionConcurrency: Resolved<number>;
  batchUrlImportConcurrency: Resolved<number>;
  maxBriefChars: Resolved<number>;
  maxJobDescriptionChars: Resolved<number>;
  maxTailoredContentChars: Resolved<number>;
  maxCoverLetterChars: Resolved<number>;
  maxFetchedJobHtmlChars: Resolved<number>;
  manualJobFetchTimeoutMs: Resolved<number>;
  manualJobFetchMinExtractedChars: Resolved<number>;
  manualJobFetchBrowserSettleMs: Resolved<number>;
  maxExtractionPromptChars: Resolved<number>;
  maxCvUploadBytes: Resolved<number>;
  maxCoverLetterUploadBytes: Resolved<number>;
  maxExpandedLatexBytes: Resolved<number>;

  // Model variants (no own default, fallback to model.value):
  modelScorer: ModelResolved;
  modelTailoring: ModelResolved;

  // Two-stage scoring. An empty model is the off switch; the provider is null
  // for "the configured one", and the effort is claude_code-only.
  scorerPrefilterModel: Resolved<string | null>;
  scorerPrefilterProvider: Resolved<string | null>;
  scorerPrefilterEffort: Resolved<string | null>;

  // Simple strings:
  defaultProfileId: string | null;
  userProfileName: string | null;
  onboardingBasicAuthDecision: "enabled" | "skipped" | null;
  cvSourceFormat: CvSourceFormat | null;
  claudeCodeEffort: string | null;
  basicAuthUser: string | null;
  basicAuthPassword: string | null;

  // Secret hints:
  llmApiKeyHint: string | null;
  basicAuthPasswordHint: string | null;
  apifyApiTokenHint: string | null;
  claudeCodeOauthTokenHint: string | null;

  // Computed:
  basicAuthActive: boolean;
}
