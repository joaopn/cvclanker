import * as api from "@client/api";
import { ActivityLogButton } from "@client/components/ActivityLogButton";
import { LlmStatusButton } from "@client/components/LlmStatusButton";
import { PageHeader } from "@client/components/layout";
import { useUpdateSettingsMutation } from "@client/hooks/queries/useSettingsMutation";
import { toast } from "@client/lib/toast";
import { ChatSettingsSection } from "@client/pages/settings/components/ChatSettingsSection";
import { ContextLimitsSection } from "@client/pages/settings/components/ContextLimitsSection";
import { DangerZoneSection } from "@client/pages/settings/components/DangerZoneSection";
import { DisplaySettingsSection } from "@client/pages/settings/components/DisplaySettingsSection";
import { EnvironmentSettingsSection } from "@client/pages/settings/components/EnvironmentSettingsSection";
import { ModelSettingsSection } from "@client/pages/settings/components/ModelSettingsSection";
import { PipelineSettingsSection } from "@client/pages/settings/components/PipelineSettingsSection";
import { PromptsPanel } from "@client/pages/settings/components/PromptsPanel";
import { UserProfilesPanel } from "@client/pages/settings/components/UserProfilesPanel";
import {
  type LlmProviderId,
  normalizeLlmProvider,
} from "@client/pages/settings/utils";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type UpdateSettingsInput,
  updateSettingsSchema,
} from "@shared/settings-schema.js";
import {
  type AppSettings,
  type JobStatus,
  SUITABILITY_CATEGORY_LABELS,
  type SuitabilityCategory,
} from "@shared/types.js";
import { useQuery } from "@tanstack/react-query";
import { Search, Settings } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, type Resolver, useForm } from "react-hook-form";
import { useLocation } from "react-router-dom";
import { useQueryErrorToast } from "@/client/hooks/useQueryErrorToast";
import { queryKeys } from "@/client/lib/queryKeys";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const DEFAULT_FORM_VALUES: UpdateSettingsInput = {
  model: "",
  modelScorer: "",
  modelTailoring: "",
  llmProvider: null,
  llmBaseUrl: "",
  llmApiKey: "",
  claudeCodeOauthToken: "",
  showSponsorInfo: null,

  renderMarkdownInJobDescriptions: null,
  chatStyleTone: "",
  chatStyleFormality: "",
  chatStyleConstraints: "",
  chatStyleDoNotUse: "",
  chatStyleSummaryMaxWords: null,
  chatStyleMaxKeywordsPerSkill: null,
  chatStyleLanguageMode: null,
  chatStyleManualLanguage: null,
  basicAuthUser: "",
  basicAuthPassword: "",
  enableBasicAuth: false,
  jwtExpirySeconds: null,
  penalizeMissingSalary: null,
  missingSalaryPenalty: null,
  autoSkipCategory: null,
  autoTailoringEnabled: null,
  enableJobScoring: null,
  inboxStaleThresholdDays: null,
  maxBulkActionJobs: null,
  maxBriefChars: null,
  maxJobDescriptionChars: null,
  maxTailoredContentChars: null,
  maxCoverLetterChars: null,
  maxFetchedJobHtmlChars: null,
  manualJobFetchTimeoutMs: null,
  manualJobFetchMinExtractedChars: null,
  manualJobFetchBrowserSettleMs: null,
  maxExtractionPromptChars: null,
  maxCvUploadBytes: null,
  maxCoverLetterUploadBytes: null,
  maxExpandedLatexBytes: null,
};

type LlmProviderValue = LlmProviderId | null;

type SettingsSectionId =
  | "model"
  | "chat"
  | "context-limits"
  | "environment"
  | "user-profiles"
  | "display"
  | "pipeline"
  | "prompts"
  | "danger-zone";

type SettingsGroupId =
  | "ai"
  | "accounts"
  | "display"
  | "pipeline"
  | "prompts"
  | "danger";

type SettingsSectionDescriptor = {
  id: SettingsSectionId;
  label: string;
  description: string;
  searchTerms: string[];
};

type SettingsNavGroup = {
  id: SettingsGroupId;
  items: SettingsSectionDescriptor[];
  label: string;
};

const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    id: "ai",
    label: "AI",
    items: [
      {
        id: "model",
        label: "Models",
        description: "Provider, API credentials, and task-specific overrides.",
        searchTerms: [
          "llm",
          "provider",
          "openai",
          "gemini",
          "ollama",
          "codex",
          "claude",
        ],
      },
      {
        id: "chat",
        label: "Writing Style",
        description: "Tone, language, presets, and writing constraints.",
        searchTerms: ["ghostwriter", "language", "tone", "formality"],
      },
      {
        id: "context-limits",
        label: "Context limits",
        description:
          "Per-field character caps that gate how much text flows into LLM prompts at the write boundary.",
        searchTerms: [
          "brief",
          "length",
          "limit",
          "truncate",
          "characters",
          "context",
        ],
      },
    ],
  },
  {
    id: "accounts",
    label: "Accounts & Security",
    items: [
      {
        id: "environment",
        label: "Accounts & Access",
        description: "Service credentials and authentication protection.",
        searchTerms: ["security", "auth", "jwt", "session"],
      },
      {
        id: "user-profiles",
        label: "User Profiles",
        description: "Switch, import, and export whole job databases.",
        searchTerms: [
          "database",
          "profile",
          "backup",
          "restore",
          "export",
          "import",
          "switch",
        ],
      },
    ],
  },
  {
    id: "display",
    label: "Display",
    items: [
      {
        id: "display",
        label: "Display Preferences",
        description: "Sponsor badges and markdown rendering behavior.",
        searchTerms: ["markdown", "sponsor", "rendering", "appearance"],
      },
    ],
  },
  {
    id: "pipeline",
    label: "Pipeline",
    items: [
      {
        id: "pipeline",
        label: "Pipeline Behavior",
        description: "Auto-tailor toggle for pipeline runs.",
        searchTerms: ["pipeline", "tailor", "auto", "scoring", "rank"],
      },
    ],
  },
  {
    id: "prompts",
    label: "Prompts",
    items: [
      {
        id: "prompts",
        label: "LLM Prompts",
        description:
          "List the YAML prompts loaded from disk and reload edits without restarting.",
        searchTerms: ["yaml", "llm", "prompt", "system", "reload"],
      },
    ],
  },
  {
    id: "danger",
    label: "Danger Zone",
    items: [
      {
        id: "danger-zone",
        label: "Danger Zone",
        description: "Delete jobs, runs, or the full local database.",
        searchTerms: ["delete", "clear", "cleanup", "destructive"],
      },
    ],
  },
];

const SECTION_FIELD_MAP: Record<
  SettingsSectionId,
  Array<keyof UpdateSettingsInput>
> = {
  model: [
    "llmProvider",
    "llmBaseUrl",
    "llmApiKey",
    "claudeCodeOauthToken",
    "model",

    "modelScorer",
    "modelTailoring",
  ],
  chat: [
    "chatStyleTone",
    "chatStyleFormality",
    "chatStyleConstraints",
    "chatStyleDoNotUse",
    "chatStyleLanguageMode",
    "chatStyleManualLanguage",
  ],
  "context-limits": [
    "maxBriefChars",
    "maxJobDescriptionChars",
    "maxTailoredContentChars",
    "maxCoverLetterChars",
    "maxFetchedJobHtmlChars",
    "maxExtractionPromptChars",
  ],
  environment: [
    "enableBasicAuth",
    "basicAuthUser",
    "basicAuthPassword",
    "jwtExpirySeconds",
  ],
  display: ["showSponsorInfo", "renderMarkdownInJobDescriptions"],
  pipeline: [
    "autoTailoringEnabled",
    "enableJobScoring",
    "inboxStaleThresholdDays",
    "maxBulkActionJobs",
    "manualJobFetchTimeoutMs",
    "manualJobFetchMinExtractedChars",
    "manualJobFetchBrowserSettleMs",
    "maxCvUploadBytes",
    "maxCoverLetterUploadBytes",
    "maxExpandedLatexBytes",
  ],
  "user-profiles": [],
  prompts: [],
  "danger-zone": [],
};

function matchesSettingsSearch(
  searchTerm: string,
  item: SettingsSectionDescriptor,
): boolean {
  if (!searchTerm) return true;
  const normalized = searchTerm.toLowerCase();
  const haystack = [item.label, item.description, ...item.searchTerms].join(
    " ",
  );
  return haystack.toLowerCase().includes(normalized);
}

const normalizeLlmProviderValue = (
  value: string | null | undefined,
): LlmProviderValue => (value ? normalizeLlmProvider(value) : null);

const NULL_SETTINGS_PAYLOAD: UpdateSettingsInput = {
  model: null,
  modelScorer: null,
  modelTailoring: null,
  llmProvider: null,
  llmBaseUrl: null,
  llmApiKey: null,
  claudeCodeOauthToken: null,
  showSponsorInfo: null,

  renderMarkdownInJobDescriptions: null,
  chatStyleTone: null,
  chatStyleFormality: null,
  chatStyleConstraints: null,
  chatStyleDoNotUse: null,
  chatStyleSummaryMaxWords: null,
  chatStyleMaxKeywordsPerSkill: null,
  chatStyleLanguageMode: null,
  chatStyleManualLanguage: null,
  basicAuthUser: null,
  basicAuthPassword: null,
  enableBasicAuth: undefined,
  jwtExpirySeconds: null,
  penalizeMissingSalary: null,
  missingSalaryPenalty: null,
  autoSkipCategory: null,
  autoTailoringEnabled: null,
  enableJobScoring: null,
  inboxStaleThresholdDays: null,
  maxBulkActionJobs: null,
  maxBriefChars: null,
  maxJobDescriptionChars: null,
  maxTailoredContentChars: null,
  maxCoverLetterChars: null,
  maxFetchedJobHtmlChars: null,
  manualJobFetchTimeoutMs: null,
  manualJobFetchMinExtractedChars: null,
  manualJobFetchBrowserSettleMs: null,
  maxExtractionPromptChars: null,
  maxCvUploadBytes: null,
  maxCoverLetterUploadBytes: null,
  maxExpandedLatexBytes: null,
};

const mapSettingsToForm = (data: AppSettings): UpdateSettingsInput => ({
  model: data.model.override ?? "",
  modelScorer: data.modelScorer.override ?? "",
  modelTailoring: data.modelTailoring.override ?? "",
  llmProvider: normalizeLlmProviderValue(
    data.llmProvider.override ?? data.llmProvider.value,
  ),
  llmBaseUrl: data.llmBaseUrl.override ?? "",
  llmApiKey: "",
  claudeCodeOauthToken: "",

  showSponsorInfo: data.showSponsorInfo.override,
  renderMarkdownInJobDescriptions:
    data.renderMarkdownInJobDescriptions.override,
  chatStyleTone: data.chatStyleTone.override ?? "",
  chatStyleFormality: data.chatStyleFormality.override ?? "",
  chatStyleConstraints: data.chatStyleConstraints.override ?? "",
  chatStyleDoNotUse: data.chatStyleDoNotUse.override ?? "",
  chatStyleSummaryMaxWords: data.chatStyleSummaryMaxWords.override ?? null,
  chatStyleMaxKeywordsPerSkill:
    data.chatStyleMaxKeywordsPerSkill.override ?? null,
  chatStyleLanguageMode: data.chatStyleLanguageMode.override ?? null,
  chatStyleManualLanguage: data.chatStyleManualLanguage.override ?? null,
  basicAuthUser: data.basicAuthUser ?? "",
  basicAuthPassword: data.basicAuthPassword ?? "",
  enableBasicAuth: data.basicAuthActive,
  jwtExpirySeconds: data.jwtExpirySeconds.override ?? null,
  penalizeMissingSalary: data.penalizeMissingSalary.override,
  missingSalaryPenalty: data.missingSalaryPenalty.override,
  autoSkipCategory: data.autoSkipCategory.override,
  autoTailoringEnabled: data.autoTailoringEnabled.override,
  enableJobScoring: data.enableJobScoring.override,
  inboxStaleThresholdDays: data.inboxStaleThresholdDays.override,
  maxBulkActionJobs: data.maxBulkActionJobs.override,
  maxBriefChars: data.maxBriefChars.override,
  maxJobDescriptionChars: data.maxJobDescriptionChars.override,
  maxTailoredContentChars: data.maxTailoredContentChars.override,
  maxCoverLetterChars: data.maxCoverLetterChars.override,
  maxFetchedJobHtmlChars: data.maxFetchedJobHtmlChars.override,
  manualJobFetchTimeoutMs: data.manualJobFetchTimeoutMs.override,
  manualJobFetchMinExtractedChars:
    data.manualJobFetchMinExtractedChars.override,
  manualJobFetchBrowserSettleMs: data.manualJobFetchBrowserSettleMs.override,
  maxExtractionPromptChars: data.maxExtractionPromptChars.override,
  maxCvUploadBytes: data.maxCvUploadBytes.override,
  maxCoverLetterUploadBytes: data.maxCoverLetterUploadBytes.override,
  maxExpandedLatexBytes: data.maxExpandedLatexBytes.override,
});

const normalizeString = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const normalizePrivateInput = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  if (trimmed === "") return null;
  return trimmed || undefined;
};

const nullIfSame = <T,>(value: T | null | undefined, defaultValue: T) =>
  value === defaultValue ? null : (value ?? null);

const getDerivedSettings = (settings: AppSettings | null) => {
  return {
    model: {
      effective: settings?.model?.value ?? "",
      default: settings?.model?.default ?? "",
      scorer: settings?.modelScorer?.value ?? "",
      tailoring: settings?.modelTailoring?.value ?? "",
      llmProvider: settings?.llmProvider?.value ?? "",
      llmBaseUrl: settings?.llmBaseUrl?.value ?? "",
      llmApiKeyHint: settings?.llmApiKeyHint ?? null,
      claudeCodeOauthTokenHint: settings?.claudeCodeOauthTokenHint ?? null,
    },
    display: {
      showSponsorInfo: {
        effective: settings?.showSponsorInfo?.value ?? true,
        default: settings?.showSponsorInfo?.default ?? true,
      },
      renderMarkdownInJobDescriptions: {
        effective: settings?.renderMarkdownInJobDescriptions?.value ?? true,
        default: settings?.renderMarkdownInJobDescriptions?.default ?? true,
      },
    },
    chat: {
      tone: {
        effective: settings?.chatStyleTone?.value ?? "professional",
        default: settings?.chatStyleTone?.default ?? "professional",
      },
      formality: {
        effective: settings?.chatStyleFormality?.value ?? "medium",
        default: settings?.chatStyleFormality?.default ?? "medium",
      },
      constraints: {
        effective: settings?.chatStyleConstraints?.value ?? "",
        default: settings?.chatStyleConstraints?.default ?? "",
      },
      doNotUse: {
        effective: settings?.chatStyleDoNotUse?.value ?? "",
        default: settings?.chatStyleDoNotUse?.default ?? "",
      },
      languageMode: {
        effective: settings?.chatStyleLanguageMode?.value ?? "manual",
        default: settings?.chatStyleLanguageMode?.default ?? "manual",
      },
      manualLanguage: {
        effective: settings?.chatStyleManualLanguage?.value ?? "english",
        default: settings?.chatStyleManualLanguage?.default ?? "english",
      },
      summaryMaxWords: {
        effective: settings?.chatStyleSummaryMaxWords?.value ?? null,
        default: settings?.chatStyleSummaryMaxWords?.default ?? null,
      },
      maxKeywordsPerSkill: {
        effective: settings?.chatStyleMaxKeywordsPerSkill?.value ?? null,
        default: settings?.chatStyleMaxKeywordsPerSkill?.default ?? null,
      },
    },
    envSettings: {
      readable: {
        basicAuthUser: settings?.basicAuthUser ?? "",
        basicAuthPassword: settings?.basicAuthPassword ?? "",
      },
      private: {
        basicAuthPasswordHint: settings?.basicAuthPasswordHint ?? null,
      },
      basicAuthActive: settings?.basicAuthActive ?? false,
      jwtExpirySeconds: {
        effective: settings?.jwtExpirySeconds?.value ?? null,
        default: settings?.jwtExpirySeconds?.default ?? null,
      },
    },
    scoring: {
      penalizeMissingSalary: {
        effective: settings?.penalizeMissingSalary?.value ?? false,
        default: settings?.penalizeMissingSalary?.default ?? false,
      },
      missingSalaryPenalty: {
        effective: settings?.missingSalaryPenalty?.value ?? 10,
        default: settings?.missingSalaryPenalty?.default ?? 10,
      },
      autoSkipCategory: {
        effective: settings?.autoSkipCategory?.value ?? null,
        default: settings?.autoSkipCategory?.default ?? null,
      },
    },
    pipeline: {
      autoTailoringEnabled: {
        effective: settings?.autoTailoringEnabled?.value ?? false,
        default: settings?.autoTailoringEnabled?.default ?? false,
      },
      enableJobScoring: {
        effective: settings?.enableJobScoring?.value ?? true,
        default: settings?.enableJobScoring?.default ?? true,
      },
      inboxStaleThresholdDays: {
        effective: settings?.inboxStaleThresholdDays?.value ?? 7,
        default: settings?.inboxStaleThresholdDays?.default ?? 7,
      },
      maxBulkActionJobs: {
        effective: settings?.maxBulkActionJobs?.value ?? 1000,
        default: settings?.maxBulkActionJobs?.default ?? 1000,
      },
      manualJobFetchTimeoutMs: {
        effective: settings?.manualJobFetchTimeoutMs?.value ?? 15_000,
        default: settings?.manualJobFetchTimeoutMs?.default ?? 15_000,
      },
      manualJobFetchMinExtractedChars: {
        effective: settings?.manualJobFetchMinExtractedChars?.value ?? 200,
        default: settings?.manualJobFetchMinExtractedChars?.default ?? 200,
      },
      manualJobFetchBrowserSettleMs: {
        effective: settings?.manualJobFetchBrowserSettleMs?.value ?? 5_000,
        default: settings?.manualJobFetchBrowserSettleMs?.default ?? 5_000,
      },
      maxCvUploadBytes: {
        effective: settings?.maxCvUploadBytes?.value ?? 50 * 1024 * 1024,
        default: settings?.maxCvUploadBytes?.default ?? 50 * 1024 * 1024,
      },
      maxCoverLetterUploadBytes: {
        effective:
          settings?.maxCoverLetterUploadBytes?.value ?? 50 * 1024 * 1024,
        default:
          settings?.maxCoverLetterUploadBytes?.default ?? 50 * 1024 * 1024,
      },
      maxExpandedLatexBytes: {
        effective: settings?.maxExpandedLatexBytes?.value ?? 50 * 1024 * 1024,
        default: settings?.maxExpandedLatexBytes?.default ?? 50 * 1024 * 1024,
      },
    },
    contextLimits: {
      maxBriefChars: {
        effective: settings?.maxBriefChars?.value ?? 200_000,
        default: settings?.maxBriefChars?.default ?? 200_000,
      },
      maxJobDescriptionChars: {
        effective: settings?.maxJobDescriptionChars?.value ?? 100_000,
        default: settings?.maxJobDescriptionChars?.default ?? 100_000,
      },
      maxTailoredContentChars: {
        effective: settings?.maxTailoredContentChars?.value ?? 100_000,
        default: settings?.maxTailoredContentChars?.default ?? 100_000,
      },
      maxCoverLetterChars: {
        effective: settings?.maxCoverLetterChars?.value ?? 50_000,
        default: settings?.maxCoverLetterChars?.default ?? 50_000,
      },
      maxFetchedJobHtmlChars: {
        effective: settings?.maxFetchedJobHtmlChars?.value ?? 500_000,
        default: settings?.maxFetchedJobHtmlChars?.default ?? 500_000,
      },
      maxExtractionPromptChars: {
        effective: settings?.maxExtractionPromptChars?.value ?? 100_000,
        default: settings?.maxExtractionPromptChars?.default ?? 100_000,
      },
    },
  };
};

export const SettingsPage: React.FC = () => {
  const location = useLocation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeSection, setActiveSection] =
    useState<SettingsSectionId>("model");
  const [openGroups, setOpenGroups] = useState<SettingsGroupId[]>([]);

  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    const allSectionIds = SETTINGS_NAV_GROUPS.flatMap((g) =>
      g.items.map((i) => i.id),
    );
    if (hash && allSectionIds.includes(hash as SettingsSectionId)) {
      setActiveSection(hash as SettingsSectionId);
      const parentGroup = SETTINGS_NAV_GROUPS.find((g) =>
        g.items.some((i) => i.id === hash),
      );
      if (parentGroup) {
        setOpenGroups((prev) =>
          prev.includes(parentGroup.id) ? prev : [...prev, parentGroup.id],
        );
      }
    }
  }, [location.hash]);

  const [settingsSearch, setSettingsSearch] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [statusesToClear, setStatusesToClear] = useState<JobStatus[]>([
    "discovered",
  ]);

  const methods = useForm<UpdateSettingsInput>({
    resolver: zodResolver(
      updateSettingsSchema,
    ) as Resolver<UpdateSettingsInput>,
    mode: "onChange",
    defaultValues: DEFAULT_FORM_VALUES,
  });

  const {
    handleSubmit,
    reset,
    setError,
    formState: { isDirty, errors, isValid, dirtyFields },
  } = methods;

  const settingsQuery = useQuery({
    queryKey: queryKeys.settings.current(),
    queryFn: api.getSettings,
  });
  const updateSettingsMutation = useUpdateSettingsMutation();
  const isLoading = settingsQuery.isLoading;

  useEffect(() => {
    if (!settingsQuery.data) return;
    setSettings(settingsQuery.data);
    reset(mapSettingsToForm(settingsQuery.data));
  }, [settingsQuery.data, reset]);

  useQueryErrorToast(settingsQuery.error, "Failed to load settings");

  const derived = getDerivedSettings(settings);
  const {
    model,
    display,
    chat,
    envSettings,
    scoring,
    pipeline,
    contextLimits,
  } = derived;

  const canSave = isDirty && isValid;

  const onSave = async (data: UpdateSettingsInput) => {
    if (!settings) return;
    if (data.enableBasicAuth && !settings.basicAuthActive) {
      const password = data.basicAuthPassword?.trim() ?? "";
      if (!password) {
        setError("basicAuthPassword", {
          type: "manual",
          message: "Password is required when authentication is enabled",
        });
        return;
      }
    }
    try {
      setIsSaving(true);

      const envPayload: Partial<UpdateSettingsInput> = {};

      if (data.enableBasicAuth === false) {
        envPayload.basicAuthUser = null;
        envPayload.basicAuthPassword = null;
      } else if (
        dirtyFields.enableBasicAuth ||
        dirtyFields.basicAuthUser ||
        dirtyFields.basicAuthPassword
      ) {
        envPayload.basicAuthUser = normalizeString(data.basicAuthUser);

        if (dirtyFields.basicAuthPassword) {
          const value = normalizePrivateInput(data.basicAuthPassword);
          if (value !== undefined) envPayload.basicAuthPassword = value;
        }
      }

      if (dirtyFields.llmProvider) {
        envPayload.llmProvider = data.llmProvider ?? null;
      }

      if (dirtyFields.llmBaseUrl) {
        envPayload.llmBaseUrl = normalizeString(data.llmBaseUrl);
      }

      if (dirtyFields.llmApiKey) {
        const value = normalizePrivateInput(data.llmApiKey);
        if (value !== undefined) envPayload.llmApiKey = value;
      }

      if (dirtyFields.claudeCodeOauthToken) {
        const value = normalizePrivateInput(data.claudeCodeOauthToken);
        if (value !== undefined) envPayload.claudeCodeOauthToken = value;
      }

      const payload: Partial<UpdateSettingsInput> = {
        model: dirtyFields.llmProvider
          ? dirtyFields.model
            ? normalizeString(data.model)
            : null
          : normalizeString(data.model),
        modelScorer: dirtyFields.llmProvider
          ? dirtyFields.modelScorer
            ? normalizeString(data.modelScorer)
            : null
          : normalizeString(data.modelScorer),
        modelTailoring: dirtyFields.llmProvider
          ? dirtyFields.modelTailoring
            ? normalizeString(data.modelTailoring)
            : null
          : normalizeString(data.modelTailoring),
        showSponsorInfo: nullIfSame(
          data.showSponsorInfo,
          display.showSponsorInfo.default,
        ),
        renderMarkdownInJobDescriptions: nullIfSame(
          data.renderMarkdownInJobDescriptions,
          display.renderMarkdownInJobDescriptions.default,
        ),
        chatStyleTone: normalizeString(data.chatStyleTone),
        chatStyleFormality: normalizeString(data.chatStyleFormality),
        chatStyleConstraints: normalizeString(data.chatStyleConstraints),
        chatStyleDoNotUse: normalizeString(data.chatStyleDoNotUse),
        chatStyleSummaryMaxWords: Number.isNaN(data.chatStyleSummaryMaxWords)
          ? null
          : (data.chatStyleSummaryMaxWords ?? null),
        chatStyleMaxKeywordsPerSkill: Number.isNaN(
          data.chatStyleMaxKeywordsPerSkill,
        )
          ? null
          : (data.chatStyleMaxKeywordsPerSkill ?? null),
        chatStyleLanguageMode: data.chatStyleLanguageMode ?? null,
        chatStyleManualLanguage: data.chatStyleManualLanguage ?? null,
        penalizeMissingSalary: nullIfSame(
          data.penalizeMissingSalary,
          scoring.penalizeMissingSalary.default,
        ),
        missingSalaryPenalty: nullIfSame(
          data.missingSalaryPenalty,
          scoring.missingSalaryPenalty.default,
        ),
        autoSkipCategory: nullIfSame(
          data.autoSkipCategory,
          scoring.autoSkipCategory.default,
        ),
        autoTailoringEnabled: nullIfSame(
          data.autoTailoringEnabled,
          pipeline.autoTailoringEnabled.default,
        ),
        jwtExpirySeconds: nullIfSame(
          data.jwtExpirySeconds,
          envSettings.jwtExpirySeconds.default,
        ),
        enableJobScoring: nullIfSame(
          data.enableJobScoring,
          pipeline.enableJobScoring.default,
        ),
        inboxStaleThresholdDays: nullIfSame(
          data.inboxStaleThresholdDays,
          pipeline.inboxStaleThresholdDays.default,
        ),
        maxBulkActionJobs: nullIfSame(
          data.maxBulkActionJobs,
          pipeline.maxBulkActionJobs.default,
        ),
        manualJobFetchTimeoutMs: nullIfSame(
          data.manualJobFetchTimeoutMs,
          pipeline.manualJobFetchTimeoutMs.default,
        ),
        manualJobFetchMinExtractedChars: nullIfSame(
          data.manualJobFetchMinExtractedChars,
          pipeline.manualJobFetchMinExtractedChars.default,
        ),
        manualJobFetchBrowserSettleMs: nullIfSame(
          data.manualJobFetchBrowserSettleMs,
          pipeline.manualJobFetchBrowserSettleMs.default,
        ),
        maxBriefChars: nullIfSame(
          data.maxBriefChars,
          contextLimits.maxBriefChars.default,
        ),
        maxJobDescriptionChars: nullIfSame(
          data.maxJobDescriptionChars,
          contextLimits.maxJobDescriptionChars.default,
        ),
        maxTailoredContentChars: nullIfSame(
          data.maxTailoredContentChars,
          contextLimits.maxTailoredContentChars.default,
        ),
        maxCoverLetterChars: nullIfSame(
          data.maxCoverLetterChars,
          contextLimits.maxCoverLetterChars.default,
        ),
        maxFetchedJobHtmlChars: nullIfSame(
          data.maxFetchedJobHtmlChars,
          contextLimits.maxFetchedJobHtmlChars.default,
        ),
        maxExtractionPromptChars: nullIfSame(
          data.maxExtractionPromptChars,
          contextLimits.maxExtractionPromptChars.default,
        ),
        maxCvUploadBytes: nullIfSame(
          data.maxCvUploadBytes,
          pipeline.maxCvUploadBytes.default,
        ),
        maxCoverLetterUploadBytes: nullIfSame(
          data.maxCoverLetterUploadBytes,
          pipeline.maxCoverLetterUploadBytes.default,
        ),
        maxExpandedLatexBytes: nullIfSame(
          data.maxExpandedLatexBytes,
          pipeline.maxExpandedLatexBytes.default,
        ),
        ...envPayload,
      };

      const updated = await updateSettingsMutation.mutateAsync(payload);
      setSettings(updated);
      reset(mapSettingsToForm(updated));
      toast.success("Settings saved");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to save settings";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearDatabase = async () => {
    try {
      setIsSaving(true);
      const result = await api.clearDatabase();
      toast.success("Database cleared", {
        description: `Deleted ${result.jobsDeleted} jobs.`,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clear database";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearByStatuses = async () => {
    if (statusesToClear.length === 0) {
      toast.error("No statuses selected");
      return;
    }
    try {
      setIsSaving(true);
      let totalDeleted = 0;
      const results: string[] = [];

      for (const status of statusesToClear) {
        const result = await api.deleteJobsByStatus(status);
        totalDeleted += result.count;
        if (result.count > 0) {
          results.push(`${result.count} ${status}`);
        }
      }

      if (totalDeleted > 0) {
        toast.success("Jobs cleared", {
          description: `Deleted ${totalDeleted} jobs: ${results.join(", ")}`,
        });
      } else {
        toast.info("No jobs found", {
          description: `No jobs with selected statuses found`,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to clear jobs";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearByCategory = async (category: SuitabilityCategory) => {
    try {
      setIsSaving(true);
      const result = await api.deleteJobsByCategory(category);
      const label = SUITABILITY_CATEGORY_LABELS[category];

      if (result.count > 0) {
        toast.success("Jobs cleared", {
          description: `Deleted ${result.count} jobs at or below "${label}". Applied jobs were preserved.`,
        });
      } else {
        toast.info("No jobs found", {
          description: `No jobs at or below "${label}".`,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to clear jobs by category";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const toggleStatusToClear = (status: JobStatus) => {
    setStatusesToClear((prev) =>
      prev.includes(status)
        ? prev.filter((s) => s !== status)
        : [...prev, status],
    );
  };

  const handleReset = async () => {
    try {
      setIsSaving(true);
      const updated = await updateSettingsMutation.mutateAsync(
        NULL_SETTINGS_PAYLOAD,
      );
      setSettings(updated);
      reset(mapSettingsToForm(updated));
      toast.success("Reset to default");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reset settings";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscardChanges = () => {
    if (!settings) return;
    reset(mapSettingsToForm(settings));
    toast.success("Discarded unsaved changes");
  };

  const filteredNavGroups = useMemo(
    () =>
      SETTINGS_NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          matchesSettingsSearch(settingsSearch, item),
        ),
      })).filter((group) => group.items.length > 0),
    [settingsSearch],
  );

  const visibleSectionIds = useMemo(
    () =>
      filteredNavGroups.flatMap((group) => group.items.map((item) => item.id)),
    [filteredNavGroups],
  );

  useEffect(() => {
    if (visibleSectionIds.length === 0) return;
    if (!visibleSectionIds.includes(activeSection)) {
      setActiveSection(visibleSectionIds[0]);
    }
  }, [activeSection, visibleSectionIds]);

  const activeSectionMeta =
    SETTINGS_NAV_GROUPS.flatMap((group) => group.items).find(
      (item) => item.id === activeSection,
    ) ?? SETTINGS_NAV_GROUPS[0].items[0];
  const activeGroup =
    SETTINGS_NAV_GROUPS.find((group) =>
      group.items.some((item) => item.id === activeSection),
    ) ?? SETTINGS_NAV_GROUPS[0];

  const sectionHasDirtyState = (sectionId: SettingsSectionId) =>
    SECTION_FIELD_MAP[sectionId].some((field) => Boolean(dirtyFields[field]));
  const sectionHasErrors = (sectionId: SettingsSectionId) =>
    SECTION_FIELD_MAP[sectionId].some((field) => Boolean(errors[field]));

  const getSectionBadge = (sectionId: SettingsSectionId) => {
    if (sectionId === "danger-zone") {
      return { label: "Sensitive", variant: "destructive" as const };
    }
    if (sectionHasErrors(sectionId)) {
      return { label: "Needs attention", variant: "destructive" as const };
    }
    if (sectionHasDirtyState(sectionId)) {
      return { label: "Unsaved", variant: "secondary" as const };
    }

    switch (sectionId) {
      case "model":
        return model.llmProvider
          ? { label: "Configured", variant: "outline" as const }
          : { label: "Using defaults", variant: "secondary" as const };
      case "chat":
        return chat.tone.effective || chat.constraints.effective
          ? { label: "Ready", variant: "outline" as const }
          : { label: "Using defaults", variant: "secondary" as const };
      case "environment":
        return envSettings.basicAuthActive
          ? { label: "Configured", variant: "outline" as const }
          : null;
      case "display":
        return { label: "Active", variant: "secondary" as const };
      default:
        return { label: "Ready", variant: "outline" as const };
    }
  };

  const selectedSectionBadge = getSectionBadge(activeSection);
  const dirtySectionCount = SETTINGS_NAV_GROUPS.flatMap(
    (group) => group.items,
  ).filter((item) => sectionHasDirtyState(item.id)).length;
  const activeSectionIsDirty = sectionHasDirtyState(activeSection);

  let activeSectionContent: React.ReactNode;
  switch (activeSection) {
    case "model":
      activeSectionContent = (
        <ModelSettingsSection
          values={model}
          isLoading={isLoading}
          isSaving={isSaving}
          layoutMode="panel"
        />
      );
      break;
    case "chat":
      activeSectionContent = (
        <ChatSettingsSection
          values={chat}
          isLoading={isLoading}
          isSaving={isSaving}
          layoutMode="panel"
        />
      );
      break;
    case "context-limits":
      activeSectionContent = (
        <ContextLimitsSection
          values={contextLimits}
          isLoading={isLoading}
          isSaving={isSaving}
          layoutMode="panel"
        />
      );
      break;
    case "environment":
      activeSectionContent = (
        <EnvironmentSettingsSection
          values={envSettings}
          isLoading={isLoading}
          isSaving={isSaving}
          layoutMode="panel"
        />
      );
      break;
    case "display":
      activeSectionContent = (
        <DisplaySettingsSection
          values={display}
          isLoading={isLoading}
          isSaving={isSaving}
          layoutMode="panel"
        />
      );
      break;
    case "pipeline":
      activeSectionContent = (
        <PipelineSettingsSection
          values={pipeline}
          isLoading={isLoading}
          isSaving={isSaving}
          layoutMode="panel"
        />
      );
      break;
    case "user-profiles":
      activeSectionContent = <UserProfilesPanel layoutMode="panel" />;
      break;
    case "prompts":
      activeSectionContent = <PromptsPanel layoutMode="panel" />;
      break;
    case "danger-zone":
      activeSectionContent = (
        <DangerZoneSection
          statusesToClear={statusesToClear}
          toggleStatusToClear={toggleStatusToClear}
          handleClearByStatuses={handleClearByStatuses}
          handleClearDatabase={handleClearDatabase}
          handleClearByCategory={handleClearByCategory}
          isLoading={isLoading}
          isSaving={isSaving}
          layoutMode="panel"
        />
      );
      break;
    default:
      activeSectionContent = null;
  }

  return (
    <FormProvider {...methods}>
      <PageHeader
        icon={Settings}
        title="Settings"
        subtitle="Configure AI, scoring, integrations, and recovery from one focused workspace."
        actions={
          <div className="flex items-center gap-2">
            <ActivityLogButton />
            <LlmStatusButton />
          </div>
        }
      />

      <main className="container mx-auto px-4 py-6 pb-12">
        <div className="grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/95">
              <div className="border-b px-4 py-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={settingsSearch}
                    onChange={(event) => setSettingsSearch(event.target.value)}
                    placeholder="Search settings"
                    className="pl-9"
                    aria-label="Search settings"
                  />
                </div>
              </div>
              <div className="p-2">
                {filteredNavGroups.length > 0 ? (
                  <Accordion
                    type="multiple"
                    value={
                      settingsSearch.trim()
                        ? filteredNavGroups.map((group) => group.id)
                        : openGroups
                    }
                    onValueChange={(value) =>
                      setOpenGroups(value as SettingsGroupId[])
                    }
                    className="space-y-1"
                  >
                    {filteredNavGroups.map((group) => (
                      <AccordionItem
                        key={group.id}
                        value={group.id}
                        className="border-b border-border/60 px-2 last:border-b-0"
                      >
                        <AccordionTrigger className="py-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground hover:no-underline">
                          {group.label}
                        </AccordionTrigger>
                        <AccordionContent className="pb-3">
                          <div className="space-y-1">
                            {group.items.map((item) => {
                              const isActive = item.id === activeSection;
                              return (
                                <Button
                                  key={item.id}
                                  type="button"
                                  variant="ghost"
                                  className={`h-9 w-full justify-start rounded-md px-3 text-left text-sm font-medium ${
                                    isActive
                                      ? "border border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                                  }`}
                                  onClick={() => setActiveSection(item.id)}
                                >
                                  {item.label}
                                </Button>
                              );
                            })}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                ) : (
                  <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                    No settings matched “{settingsSearch.trim()}”.
                  </div>
                )}
              </div>
            </div>
          </aside>

          <section className="space-y-4">
            <header className="space-y-4 border-b border-border/70 pb-5">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
                <span>{activeGroup.label}</span>
                <span>/</span>
                <span>{activeSectionMeta.label}</span>
              </div>

              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-2xl font-semibold tracking-tight">
                      {activeSectionMeta.label}
                    </h2>
                    {selectedSectionBadge ? (
                      <Badge variant={selectedSectionBadge.variant}>
                        {selectedSectionBadge.label}
                      </Badge>
                    ) : null}
                    {dirtySectionCount > 0 ? (
                      <Badge variant="secondary">
                        {dirtySectionCount} unsaved section
                        {dirtySectionCount !== 1 ? "s" : ""}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                    {activeSectionMeta.description}
                  </p>
                </div>

                <div className="flex shrink-0 flex-nowrap gap-2 self-start">
                  {activeSectionIsDirty ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="whitespace-nowrap"
                      onClick={handleDiscardChanges}
                      disabled={isLoading || isSaving || !isDirty}
                    >
                      Discard changes
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    className="whitespace-nowrap"
                    onClick={handleReset}
                    disabled={isLoading || isSaving || !settings}
                  >
                    Reset to defaults
                  </Button>
                  <Button
                    type="button"
                    className="whitespace-nowrap"
                    onClick={handleSubmit(onSave)}
                    disabled={isLoading || isSaving || !canSave}
                  >
                    {isSaving ? "Saving..." : "Save changes"}
                  </Button>
                </div>
              </div>
            </header>

            {activeSectionContent}

            {Object.keys(errors).length > 0 && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/[0.03] px-4 py-3 text-sm text-destructive">
                Please fix the highlighted errors before saving.
              </div>
            )}
          </section>
        </div>
      </main>
    </FormProvider>
  );
};
