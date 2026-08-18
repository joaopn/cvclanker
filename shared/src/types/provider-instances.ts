import type { SourceConfigGlobalField } from "./source-config";

export interface ProviderInstanceRow {
  id: string;
  providerId: string;
  actorRef: string;
  label: string;
  templateId: string | null;
  enabled: boolean;
  inputTemplateJson: string;
  outputMappingJson: string;
  mappings: Partial<Record<SourceConfigGlobalField, boolean>>;
  // Optional per-instance cap on jobs scraped per search, exposed directly to
  // the user. When set it overrides the run-budget-derived max for this actor;
  // also available to input templates as the `{{maxJobs}}` placeholder.
  maxJobs?: number;
  // Optional per-instance max job age in days. When set it overrides the
  // global "Max job age to scrape" setting for this actor; also available to
  // input templates as the `{{maxAgeDays}}` placeholder.
  maxAgeDays?: number;
  updatedAt: string;
}

export interface CreateProviderInstanceInput {
  providerId: string;
  actorRef: string;
  label: string;
  templateId?: string | null;
  enabled?: boolean;
  inputTemplateJson: string;
  outputMappingJson?: string;
  mappings?: Partial<Record<SourceConfigGlobalField, boolean>>;
  maxJobs?: number;
  maxAgeDays?: number;
}

export interface UpdateProviderInstanceInput {
  actorRef?: string;
  label?: string;
  templateId?: string | null;
  enabled?: boolean;
  inputTemplateJson?: string;
  outputMappingJson?: string;
  mappings?: Partial<Record<SourceConfigGlobalField, boolean>>;
  // `null` clears the override; `undefined` leaves it untouched.
  maxJobs?: number | null;
  maxAgeDays?: number | null;
}

export interface ProviderActorTemplateSummary {
  id: string;
  providerId: string;
  actorRef: string;
  displayName: string;
  description: string;
  defaultInputTemplate: string;
  defaultMappings: Partial<Record<SourceConfigGlobalField, boolean>>;
  /**
   * What this actor actually does with a max job age, shown next to the field
   * that sets it. Actors honour it very differently — exactly, or bucketed and
   * rounded up — and the difference costs money on a pay-per-result actor.
   */
  maxAgeNote?: string;
}
