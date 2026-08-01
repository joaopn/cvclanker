import type { ValidationResult } from "@shared/types.js";

export type ValidationState = ValidationResult & {
  checked: boolean;
  hydrated: boolean;
};

export type OnboardingFormData = {
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  personalBrief: string;
  searchTerms: string[];
  searchTermDraft: string;
  basicAuthUser: string;
  basicAuthPassword: string;
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
