import type { CodexAuthStatusResponse } from "@client/api";
import type { LlmProviderId } from "@client/pages/settings/utils";
import type { ValidationResult } from "@shared/types.js";

export type ValidationState = ValidationResult & {
  checked: boolean;
  hydrated: boolean;
};

/** One row of the LLM step's "Configured providers" box. */
export type ConfiguredLlmProvider = {
  provider: LlmProviderId;
  /** The provider every ordinary LLM call runs on (the settings trio). */
  usedByApp: boolean;
  details: string[];
};

/** The result of the "Add provider" box's Test, for the provider it tested. */
export type LlmTestResult = ValidationResult & { provider: LlmProviderId };

/** Everything the LLM step renders and calls, built by `useOnboardingFlow`. */
export type LlmStepModel = {
  /** The provider picked in "Add provider"; null once every one is added. */
  addProvider: LlmProviderId | null;
  addableProviders: LlmProviderId[];
  /** True while no provider is in use: Add makes the picked one the app's. */
  addMakesAppProvider: boolean;
  addDisabledReason: string | null;
  canTest: boolean;
  /** Why Test is off when a typed key would not explain it. */
  testDisabledReason: string | null;
  claudeCodeTokenHint: string | null;
  codexSignedIn: boolean;
  configuredProviders: ConfiguredLlmProvider[];
  isTesting: boolean;
  /** The check of the app's saved provider is running. */
  isValidating: boolean;
  testResult: LlmTestResult | null;
  /** The last check of the app's saved provider. */
  validation: ValidationState;
  onSelectProvider: (provider: LlmProviderId) => void;
  onTest: () => Promise<void>;
  onAdd: () => Promise<void>;
  onRemove: (provider: LlmProviderId) => Promise<void>;
  onCodexStatusChange: (status: CodexAuthStatusResponse) => void;
};

export type OnboardingFormData = {
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  claudeCodeOauthToken: string;
  personalBrief: string;

  searchTerms: string[];
  searchTermDraft: string;
  basicAuthUser: string;
  basicAuthPassword: string;
  candidateName: string;
};

export type StepId =
  | "llm"
  | "cvformat"
  | "cv"
  | "searchprofile"
  | "sources"
  | "finalize";
export type BasicAuthChoice = "enable" | "skip" | null;
export type CvChoice = "upload" | "skip" | null;
export type CvFormatChoice = "latex" | "docx" | null;

export type OnboardingStep = {
  id: StepId;
  label: string;
  subtitle: string;
  complete: boolean;
  disabled: boolean;
};
