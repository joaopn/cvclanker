import type {
  ChatStyleLanguageMode,
  ChatStyleManualLanguage,
  SuitabilityCategory,
} from "@shared/types.js";

export type EffectiveDefault<T> = {
  effective: T;
  default: T;
};

export type ModelValues = EffectiveDefault<string> & {
  scorer: string;
  tailoring: string;
  /** Two-stage scoring: empty model means the screen is off. */
  prefilterModel: string;
  prefilterProvider: string | null;
  prefilterEffort: string | null;
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKeyHint: string | null;
  claudeCodeOauthTokenHint: string | null;
};

export type DisplayValues = {
  showSponsorInfo: EffectiveDefault<boolean>;
  renderMarkdownInJobDescriptions: EffectiveDefault<boolean>;
};
export type ChatValues = {
  tone: EffectiveDefault<string>;
  formality: EffectiveDefault<string>;
  constraints: EffectiveDefault<string>;
  doNotUse: EffectiveDefault<string>;
  languageMode: EffectiveDefault<ChatStyleLanguageMode>;
  manualLanguage: EffectiveDefault<ChatStyleManualLanguage>;
  summaryMaxWords: EffectiveDefault<number | null>;
  maxKeywordsPerSkill: EffectiveDefault<number | null>;
};

export type EnvSettingsValues = {
  readable: {
    basicAuthUser: string;
    basicAuthPassword: string;
  };
  private: {
    basicAuthPasswordHint: string | null;
  };
  basicAuthActive: boolean;
  jwtExpirySeconds: EffectiveDefault<number | null>;
};

export type PipelineSettingsValues = {
  autoTailoringEnabled: EffectiveDefault<boolean>;
  enableJobScoring: EffectiveDefault<boolean>;
  liveStatusRefreshEnabled: EffectiveDefault<boolean>;
  liveStatusRefreshLimit: EffectiveDefault<number>;
  liveStatusRefreshMinAgeHours: EffectiveDefault<number>;
  autoSkipCategory: EffectiveDefault<SuitabilityCategory | null>;
  scoringInstructions: EffectiveDefault<string>;
  inboxStaleThresholdDays: EffectiveDefault<number>;
  maxBulkActionJobs: EffectiveDefault<number>;
  discoveryConcurrency: EffectiveDefault<number>;
  llmRateLimitRetries: EffectiveDefault<number>;
  llmRequestTimeoutMs: EffectiveDefault<number>;
  latexCompileTimeoutMs: EffectiveDefault<number>;
  scoringConcurrency: EffectiveDefault<number>;
  tailoringConcurrency: EffectiveDefault<number>;
  bulkActionConcurrency: EffectiveDefault<number>;
  batchUrlImportConcurrency: EffectiveDefault<number>;
  manualJobFetchTimeoutMs: EffectiveDefault<number>;
  manualJobFetchMinExtractedChars: EffectiveDefault<number>;
  manualJobFetchBrowserSettleMs: EffectiveDefault<number>;
  maxCvUploadBytes: EffectiveDefault<number>;
  maxCoverLetterUploadBytes: EffectiveDefault<number>;
  maxExpandedLatexBytes: EffectiveDefault<number>;
};

export type ContextLimitsValues = {
  maxBriefChars: EffectiveDefault<number>;
  maxJobDescriptionChars: EffectiveDefault<number>;
  maxTailoredContentChars: EffectiveDefault<number>;
  maxCoverLetterChars: EffectiveDefault<number>;
  maxFetchedJobHtmlChars: EffectiveDefault<number>;
  maxExtractionPromptChars: EffectiveDefault<number>;
};
