import * as api from "@client/api";
import { useSettings } from "@client/hooks/useSettings";
import {
  hasCompletedBasicAuthOnboarding,
  isOnboardingComplete,
} from "@client/lib/onboarding";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import {
  buildConfig,
  type EditorForm,
  enabledExtractorIdsOf,
  enabledInstanceIdsOf,
  formFromConfig,
  nextPinSet,
} from "@client/pages/profiles/ProfileConfigFields";
import {
  getLlmProviderConfig,
  normalizeLlmProvider,
} from "@client/pages/settings/utils";
import { getDefaultModelForProvider } from "@shared/settings-registry";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type {
  AppSettings,
  CvDocument,
  CvDocumentSummary,
  ProviderInstanceRow,
  SearchTermsSuggestionResponse,
  ValidationResult,
} from "@shared/types.js";
import { normalizeSearchTerms } from "@shared/utils/search-terms";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { EMPTY_VALIDATION_STATE, STEP_COPY } from "./content";
import type {
  BasicAuthChoice,
  CvChoice,
  CvFormatChoice,
  OnboardingFormData,
  OnboardingStep,
  StepId,
  ValidationState,
} from "./types";

function resolvePrimaryLabel(args: {
  basicAuthChoice: BasicAuthChoice;
  currentStep: StepId | null;
  cvChoice: CvChoice;
  cvFormatChoice: CvFormatChoice;
  cvFormatComplete: boolean;
  hasCvDocument: boolean;
  hasEnabledSource: boolean;
  hasSavedSearchTermsInSession: boolean;
  llmValidated: boolean;
}): string {
  if (args.currentStep === "llm") {
    return args.llmValidated ? "Revalidate connection" : "Save connection";
  }
  if (args.currentStep === "cvformat") {
    if (args.cvFormatComplete) return "Continue";
    return args.cvFormatChoice === null ? "Choose a format" : "Save CV format";
  }
  if (args.currentStep === "cv") {
    if (args.cvChoice === "skip") return "Finish step";
    return args.hasCvDocument ? "Save brief" : "Upload to continue";
  }
  if (args.currentStep === "searchprofile") {
    return args.hasSavedSearchTermsInSession
      ? "Update search profile"
      : "Save search profile";
  }
  if (args.currentStep === "sources") {
    return args.hasEnabledSource ? "Save sources" : "Pick at least one source";
  }
  if (args.basicAuthChoice === "enable") return "Enable authentication";
  return args.basicAuthChoice === "skip"
    ? "Finish onboarding"
    : "Choose an option";
}

export function useOnboardingFlow() {
  const queryClient = useQueryClient();
  const { settings, isLoading: settingsLoading } = useSettings();

  const [isSaving, setIsSaving] = useState(false);
  const [isValidatingLlm, setIsValidatingLlm] = useState(false);
  const [isGeneratingSearchTerms, setIsGeneratingSearchTerms] = useState(false);
  const [llmValidation, setLlmValidation] = useState<ValidationState>(
    EMPTY_VALIDATION_STATE,
  );
  // Defaults to "skip": the PI's call. The settings-reset effect below re-seeds
  // this on the first settings load, so BOTH sites must say "skip" or one
  // silently overwrites the other.
  const [basicAuthChoice, setBasicAuthChoice] =
    useState<BasicAuthChoice>("skip");
  const [cvFormatChoice, setCvFormatChoice] = useState<CvFormatChoice>(null);
  const [cvChoice, setCvChoice] = useState<CvChoice>(null);
  const [cvDocument, setCvDocument] = useState<CvDocument | null>(null);
  const cvHydratedRef = useRef(false);
  const [searchTermsSaved, setSearchTermsSaved] = useState(false);
  const [hasSavedSearchTermsInSession, setHasSavedSearchTermsInSession] =
    useState(false);
  const [searchTermsSource, setSearchTermsSource] = useState<
    SearchTermsSuggestionResponse["source"] | null
  >(null);
  const [searchTermsStale, setSearchTermsStale] = useState(false);
  const [currentStep, setCurrentStep] = useState<StepId | null>(null);
  const profileTermsKeyRef = useRef<string | null>(null);
  const [profileForm, setProfileForm] = useState<EditorForm | null>(null);
  const profileHydratedRef = useRef(false);
  const [sourceEnabledIds, setSourceEnabledIds] = useState<string[] | null>(
    null,
  );
  const sourcesHydratedRef = useRef(false);
  const [instanceEnabledIds, setInstanceEnabledIds] = useState<string[] | null>(
    null,
  );
  const instancesHydratedRef = useRef(false);
  const autoSuggestedRef = useRef(false);

  const { control, getValues, reset, setValue, watch } =
    useForm<OnboardingFormData>({
      defaultValues: {
        llmProvider: "",
        llmBaseUrl: "",
        llmApiKey: "",
        personalBrief: "",
        searchTerms: [],
        searchTermDraft: "",
        basicAuthUser: "",
        basicAuthPassword: "",
      },
    });

  const syncSettingsCache = useCallback(
    (nextSettings: AppSettings) => {
      queryClient.setQueryData(queryKeys.settings.current(), nextSettings);
    },
    [queryClient],
  );

  const profilesQuery = useQuery({
    queryKey: queryKeys.profiles.list(),
    queryFn: api.getProfiles,
  });
  const sourcesQuery = useQuery({
    queryKey: queryKeys.sourceConfigs.list(),
    queryFn: api.getSourceConfigs,
  });
  const instancesQuery = useQuery({
    queryKey: queryKeys.providerInstances.list(),
    queryFn: api.getProviderInstances,
  });

  const defaultProfileId =
    profilesQuery.data?.defaultProfileId ??
    profilesQuery.data?.profiles[0]?.id ??
    null;
  const defaultProfile =
    profilesQuery.data?.profiles.find(
      (profile) => profile.id === defaultProfileId,
    ) ?? null;
  const defaultProfileTerms = defaultProfile?.config.searchTerms ?? [];

  const extractors = sourcesQuery.data?.extractors ?? [];
  const instances =
    instancesQuery.data?.providers.flatMap((provider) => provider.instances) ??
    [];
  const apifyProvider =
    instancesQuery.data?.providers.find(
      (provider) => provider.id === "apify",
    ) ?? null;
  const apifyProviderId = apifyProvider?.id ?? null;
  const apifyTemplates = apifyProvider?.templates ?? [];

  useEffect(() => {
    if (!settings) return;

    setLlmValidation(EMPTY_VALIDATION_STATE);
    reset({
      llmProvider: settings.llmProvider?.value || "",
      llmBaseUrl: settings.llmBaseUrl?.value || "",
      llmApiKey: "",
      personalBrief: "",
      searchTerms: getValues().searchTerms,
      searchTermDraft: "",
      basicAuthUser: settings.basicAuthUser ?? "",
      basicAuthPassword: "",
    });
    // Auth already on → "enable". Everything else (an explicit earlier skip, or
    // an untouched install) defaults to "skip" — the PI's call. Must match the
    // useState initializer above, which this overwrites on the first load.
    setBasicAuthChoice(settings.basicAuthActive ? "enable" : "skip");
    // Deliberately left unselected when unset: the write is permanent for
    // this user profile, so the user has to pick rather than blow past a
    // pre-selected default.
    setCvFormatChoice(settings.cvSourceFormat);
  }, [getValues, reset, settings]);

  // Seed the search-terms field + completion flags from the default Profile.
  // Key-guarded so a same-data refetch is a no-op (never clobbers unsaved
  // mid-step edits); a genuinely changed value reseeds — the same semantics
  // the settings-override key ref used to provide.
  useEffect(() => {
    if (!profilesQuery.data) return;
    const key = JSON.stringify(defaultProfileTerms);
    if (profileTermsKeyRef.current === key) return;
    profileTermsKeyRef.current = key;
    const hasSavedTerms = defaultProfileTerms.length > 0;
    setValue("searchTerms", defaultProfileTerms);
    setSearchTermsSaved(hasSavedTerms);
    setHasSavedSearchTermsInSession(hasSavedTerms);
    setSearchTermsSource(null);
    setSearchTermsStale(false);
  }, [defaultProfileTerms, profilesQuery.data, setValue]);

  // The rest of the default Profile's config (location, budget, sources…).
  // Hydrated once so unsaved mid-step edits survive a background refetch;
  // `searchTerms` deliberately does NOT live here — it stays in react-hook-form
  // (OnboardingPage watches it, and the completion flag reads it).
  useEffect(() => {
    if (profileHydratedRef.current) return;
    if (!defaultProfile) return;
    profileHydratedRef.current = true;
    setProfileForm(formFromConfig(defaultProfile.name, defaultProfile.config));
  }, [defaultProfile]);

  // Which sources this installation may scrape at all (`source_configs.enabled`).
  // Hydrated once from the server's current state — migrate enables every
  // extractor, so a fresh install arrives with all of them ticked.
  useEffect(() => {
    if (sourcesHydratedRef.current) return;
    if (!sourcesQuery.data) return;
    sourcesHydratedRef.current = true;
    setSourceEnabledIds(enabledExtractorIdsOf(sourcesQuery.data.extractors));
  }, [sourcesQuery.data]);

  // The Apify ticks. Hydrated from `instance.enabled` ALONE, never from
  // "enabled AND pinned": an enabled-but-unpinned actor would otherwise arrive
  // unticked, and the authoritative save below would then DISABLE it — undoing
  // a decision the user made on the Sources page. So an unticked actor here is
  // always a disabled one.
  useEffect(() => {
    if (instancesHydratedRef.current) return;
    if (!instancesQuery.data) return;
    instancesHydratedRef.current = true;
    setInstanceEnabledIds(
      enabledInstanceIdsOf(
        instancesQuery.data.providers.flatMap((provider) => provider.instances),
      ),
    );
  }, [instancesQuery.data]);

  const llmProvider = watch("llmProvider");
  const selectedProvider = normalizeLlmProvider(
    llmProvider || settings?.llmProvider?.value || "openrouter",
  );
  const providerConfig = getLlmProviderConfig(selectedProvider);
  const {
    normalizedProvider,
    showApiKey,
    showBaseUrl,
    requiresApiKey: requiresLlmKey,
  } = providerConfig;

  const llmKeyHint = settings?.llmApiKeyHint ?? null;
  const hasLlmKey = Boolean(llmKeyHint);
  const llmValidated = llmValidation.valid;
  const searchTermsComplete = searchTermsSaved && !searchTermsStale;
  const basicAuthComplete = hasCompletedBasicAuthOnboarding(settings);

  const cvListQuery = useQuery<CvDocumentSummary[]>({
    queryKey: queryKeys.cvDocuments.list(),
    queryFn: api.listCvDocuments,
  });
  const activeCvId = cvListQuery.data?.[0]?.id ?? null;
  const cvDetailQuery = useQuery<CvDocument>({
    queryKey: activeCvId
      ? queryKeys.cvDocuments.detail(activeCvId)
      : ["cv-documents", "detail", "none"],
    queryFn: () => {
      if (!activeCvId) throw new Error("No active CV");
      return api.getCvDocument(activeCvId);
    },
    enabled: Boolean(activeCvId),
  });

  // Hydrate CV state once when the detail query lands. After hydration the
  // user owns the brief textarea — re-syncing here would clobber unsaved edits.
  useEffect(() => {
    if (cvHydratedRef.current) return;
    if (cvListQuery.isLoading || cvDetailQuery.isFetching) return;
    if (cvDetailQuery.data) {
      setCvDocument(cvDetailQuery.data);
      setCvChoice("upload");
      setValue("personalBrief", cvDetailQuery.data.personalBrief, {
        shouldDirty: false,
      });
      cvHydratedRef.current = true;
    } else if (!activeCvId && !cvListQuery.isLoading) {
      cvHydratedRef.current = true;
    }
  }, [
    activeCvId,
    cvDetailQuery.data,
    cvDetailQuery.isFetching,
    cvListQuery.isLoading,
    setValue,
  ]);

  const cvComplete = Boolean(cvDocument) || cvChoice === "skip";
  const storedCvSourceFormat = settings?.cvSourceFormat ?? null;
  const cvFormatComplete = storedCvSourceFormat !== null;
  const hasExistingCv = Boolean(activeCvId);
  // The step is complete when the installation actually has a source enabled —
  // which a fresh install does, since migrate enables every extractor. An Apify
  // actor counts, matching the server's run-time rule (a run is refused only
  // when NEITHER an extractor nor an instance is effective).
  const sourcesComplete =
    extractors.some((extractor) => extractor.row.enabled) ||
    instances.some((instance) => instance.enabled);
  const hasEnabledSource =
    (sourceEnabledIds?.length ?? 0) + (instanceEnabledIds?.length ?? 0) > 0;

  const toValidationState = useCallback(
    (
      result: ValidationResult,
      options?: {
        markChecked?: boolean;
      },
    ): ValidationState => ({
      ...result,
      checked: options?.markChecked ?? true,
      hydrated: true,
    }),
    [],
  );

  const validateLlm = useCallback(
    async (options?: { markChecked?: boolean }) => {
      const values = getValues();

      setIsValidatingLlm(true);
      try {
        const result = await api.validateLlm({
          provider: selectedProvider,
          baseUrl: showBaseUrl
            ? values.llmBaseUrl.trim() || undefined
            : undefined,
          apiKey: requiresLlmKey
            ? values.llmApiKey.trim() || undefined
            : undefined,
        });
        setLlmValidation(toValidationState(result, options));
        return result;
      } catch (error) {
        const result = {
          valid: false,
          message:
            error instanceof Error ? error.message : "LLM validation failed",
        };
        setLlmValidation(toValidationState(result, options));
        return result;
      } finally {
        setIsValidatingLlm(false);
      }
    },
    [
      getValues,
      requiresLlmKey,
      selectedProvider,
      showBaseUrl,
      toValidationState,
    ],
  );

  useEffect(() => {
    if (!showBaseUrl) {
      setValue("llmBaseUrl", "");
    }
  }, [setValue, showBaseUrl]);

  useEffect(() => {
    if (!selectedProvider) return;
    setLlmValidation(EMPTY_VALIDATION_STATE);
  }, [selectedProvider]);

  useEffect(() => {
    if (!settings || settingsLoading) return;
    if (llmValidation.hydrated) return;
    void validateLlm({ markChecked: false });
  }, [llmValidation.hydrated, settings, settingsLoading, validateLlm]);

  const steps = useMemo<OnboardingStep[]>(
    () => [
      {
        id: "llm",
        label: "LLM",
        subtitle: "Provider, credentials, and endpoint",
        complete: llmValidated,
        disabled: false,
      },
      {
        id: "cvformat",
        label: "CV format",
        subtitle: "LaTeX or Word",
        complete: cvFormatComplete,
        disabled: false,
      },
      {
        id: "cv",
        label: "CV",
        subtitle: "Upload your CV or skip",
        complete: cvComplete,
        disabled: false,
      },
      {
        id: "searchprofile",
        label: "Search profile",
        subtitle: "Titles and location",
        complete: searchTermsComplete,
        disabled: false,
      },
      {
        id: "sources",
        label: "Sources",
        subtitle: "Job boards to scrape",
        complete: sourcesComplete,
        disabled: false,
      },
      {
        id: "finalize",
        label: "Finalize",
        subtitle: "Sign-in and appearance",
        // Keyed on the basic-auth decision ALONE. The theme half of this step
        // is a per-device localStorage preference with no server-side value to
        // check, and gating on it would push existing installs back through
        // onboarding.
        complete: basicAuthComplete,
        disabled: false,
      },
    ],
    [
      basicAuthComplete,
      cvComplete,
      cvFormatComplete,
      sourcesComplete,
      llmValidated,
      searchTermsComplete,
    ],
  );

  useEffect(() => {
    if (!steps.length) return;

    setCurrentStep((existing) => {
      if (!existing) return steps[0].id;
      const existingStep = steps.find((step) => step.id === existing);
      if (!existingStep) return steps[0].id;
      return existing;
    });
  }, [steps]);

  const progressValue =
    steps.length > 0
      ? Math.round(
          (steps.filter((step) => step.complete).length / steps.length) * 100,
        )
      : 0;

  const complete = isOnboardingComplete({
    settings,
    llmValid: llmValidated,
    searchTermsValid: searchTermsComplete,
  });

  const handleSaveLlm = useCallback(async () => {
    const values = getValues();
    const apiKeyValue = values.llmApiKey.trim();
    const baseUrlValue = values.llmBaseUrl.trim();

    if (requiresLlmKey && !apiKeyValue && !hasLlmKey) {
      toast.info("Add your LLM API key to continue");
      return false;
    }

    const validation = await validateLlm();

    if (!validation.valid) {
      toast.error(validation.message || "LLM validation failed");
      return false;
    }

    const update: Partial<UpdateSettingsInput> = {
      llmProvider: normalizedProvider,
      llmBaseUrl: showBaseUrl ? baseUrlValue || null : null,
      model: null,
      modelScorer: null,
      modelTailoring: null,
    };

    if (showApiKey && apiKeyValue) {
      update.llmApiKey = apiKeyValue;
    }

    try {
      setIsSaving(true);
      const nextSettings = await api.updateSettings(update);
      syncSettingsCache(nextSettings);
      setValue("llmApiKey", "");
      const defaultModel = getDefaultModelForProvider(normalizedProvider);
      toast.success("LLM provider connected", {
        description:
          normalizedProvider === "openai" || normalizedProvider === "gemini"
            ? `Default for ${providerConfig.label}: ${defaultModel}.`
            : "You can fine-tune models later in Settings.",
      });
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save LLM settings",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [
    getValues,
    hasLlmKey,
    normalizedProvider,
    providerConfig.label,
    requiresLlmKey,
    setValue,
    showApiKey,
    showBaseUrl,
    syncSettingsCache,
    validateLlm,
  ]);

  const markSearchTermsStale = useCallback(() => {
    const currentTerms = getValues().searchTerms;
    if (currentTerms.length === 0 && !hasSavedSearchTermsInSession) return;
    setSearchTermsSaved(false);
    setSearchTermsStale(true);
    setSearchTermsSource(null);
  }, [getValues, hasSavedSearchTermsInSession]);

  const handleGenerateSearchTerms = useCallback(
    async (options?: { showToast?: boolean }) => {
      try {
        setIsGeneratingSearchTerms(true);
        const result = await api.suggestOnboardingSearchTerms();
        setValue("searchTerms", result.terms, { shouldDirty: true });
        setValue("searchTermDraft", "");
        setSearchTermsSaved(false);
        setSearchTermsSource(result.source);
        setSearchTermsStale(false);

        if (options?.showToast) {
          toast.success("Search terms refreshed");
        }

        return result;
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to suggest search terms",
        );
        return null;
      } finally {
        setIsGeneratingSearchTerms(false);
      }
    },
    [setValue],
  );

  // Auto-fill the titles from the CV the first time the user reaches the step.
  // FOUR guards, and the first is load-bearing: `defaultProfileTerms` falls back
  // to `[]` while the profiles query is in flight, so "no saved terms" is a
  // FALSE POSITIVE on pending data — the suggestion would land and then be
  // wiped by the profile-seed effect's first-arrival run (which also nulls
  // `searchTermsSource`, hiding the "from your resume" alert). Never treat "no
  // data yet" as "no terms".
  useEffect(() => {
    if (autoSuggestedRef.current) return;
    if (currentStep !== "searchprofile") return;
    if (!profilesQuery.data) return;
    if (defaultProfileTerms.length > 0) return;
    if (!cvDocument) return;
    autoSuggestedRef.current = true;
    void handleGenerateSearchTerms();
  }, [
    currentStep,
    profilesQuery.data,
    defaultProfileTerms,
    cvDocument,
    handleGenerateSearchTerms,
  ]);

  // Search terms live in react-hook-form; the rest of the profile config lives
  // in `profileForm`. This adapter lets the shared ProfileConfigFields treat
  // them as one object.
  const handleProfileFormChange = useCallback(
    (patch: Partial<EditorForm>) => {
      if (patch.searchTerms !== undefined) {
        setValue("searchTerms", patch.searchTerms, { shouldDirty: true });
      }
      if (patch.searchTermsDraft !== undefined) {
        setValue("searchTermDraft", patch.searchTermsDraft);
      }
      const { searchTerms, searchTermsDraft, ...rest } = patch;
      if (Object.keys(rest).length > 0) {
        setProfileForm((prev) => (prev ? { ...prev, ...rest } : prev));
      }
    },
    [setValue],
  );

  const handleSaveSearchProfile = useCallback(async () => {
    const nextTerms = normalizeSearchTerms(getValues().searchTerms);

    if (nextTerms.length === 0) {
      toast.info("Add at least one job title to continue");
      return false;
    }

    if (!defaultProfileId || !profileForm) {
      toast.error("No profile is available to save the search profile to");
      return false;
    }

    try {
      setIsSaving(true);
      const updated = await api.updateProfile(defaultProfileId, {
        config: buildConfig(
          { ...profileForm, searchTerms: nextTerms, searchTermsDraft: "" },
          defaultProfile?.config,
        ),
      });
      queryClient.setQueryData<api.ProfilesResponse>(
        queryKeys.profiles.list(),
        (prev) =>
          prev
            ? {
                ...prev,
                profiles: prev.profiles.map((profile) =>
                  profile.id === updated.id ? updated : profile,
                ),
              }
            : prev,
      );
      setValue("searchTerms", nextTerms);
      setValue("searchTermDraft", "");
      setSearchTermsSaved(true);
      setHasSavedSearchTermsInSession(true);
      setSearchTermsStale(false);
      toast.success("Search profile saved");
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to save the search profile",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [
    defaultProfile,
    defaultProfileId,
    getValues,
    profileForm,
    queryClient,
    setValue,
  ]);

  const handleToggleSource = useCallback(
    (extractorId: string, enabled: boolean) => {
      setSourceEnabledIds((prev) =>
        nextPinSet(prev ?? [], extractorId, enabled),
      );
    },
    [],
  );

  const handleToggleInstance = useCallback(
    (instanceId: string, enabled: boolean) => {
      setInstanceEnabledIds((prev) =>
        nextPinSet(prev ?? [], instanceId, enabled),
      );
    },
    [],
  );

  // The dialog creates wizard actors ENABLED, and the tick list is hydrate-once,
  // so it would never see the new row on its own.
  const handleInstanceCreated = useCallback((instance: ProviderInstanceRow) => {
    setInstanceEnabledIds((prev) => nextPinSet(prev ?? [], instance.id, true));
  }, []);

  const handleSaveSources = useCallback(async () => {
    const pickedExtractors = sourceEnabledIds ?? [];
    const pickedInstances = instanceEnabledIds ?? [];

    if (pickedExtractors.length === 0 && pickedInstances.length === 0) {
      toast.info("Pick at least one source to continue");
      return false;
    }

    // Only write the ones that actually changed. `upsertSourceConfig` preserves
    // `config`/`mappings` when the patch omits them, so an enabled-only write
    // cannot clobber an extractor's settings.
    const changedExtractors = extractors.filter(
      (extractor) =>
        extractor.row.enabled !==
        pickedExtractors.includes(extractor.extractorId),
    );
    const changedInstances = instances.filter(
      (instance) => instance.enabled !== pickedInstances.includes(instance.id),
    );

    // WHAT THE STEP SHOWS IS WHAT GETS SAVED. The extractor ticks write the
    // User-Profile level only (migrate already pinned every enabled extractor
    // into every Search Profile). Apify pins are never backfilled — money safety
    // — so the actor ticks are the only thing that can write them, and they write
    // BOTH levels: the default profile's actor pins become exactly the ticked
    // set. A null tick list means the instances query has not landed; never
    // derive pins from it, or a Save would rewrite pins the step never rendered.
    //
    // NO existence filter against `instances`: the dialog invalidates the
    // instances query without awaiting it, so a just-created actor sits in the
    // tick list before it appears in `instances`, and filtering would silently
    // drop the pin of the very actor the user just added. A pin for an id that no
    // longer exists is harmless — the run intersects profile pins with the
    // enabled instances before using them.
    const nextPins = instanceEnabledIds;
    const storedPins = defaultProfile?.config.providerInstanceIds ?? [];
    const pinsChanged =
      nextPins !== null &&
      (nextPins.length !== storedPins.length ||
        nextPins.some((id) => !storedPins.includes(id)));

    // Refuse BEFORE any write when a pin write is due but no profile resolved
    // (query unlanded or errored). Writing the instance enables anyway would
    // leave an actor enabled-but-unpinned — configured in the UI, absent from
    // every run — under a green "Sources saved" toast. Note `storedPins` falls
    // back to `[]` when the profile is missing, so this catches every case that
    // WOULD have written a pin, not every case the user touched an actor; a
    // change that leaves the pin set empty writes only the (inert) disable.
    if (pinsChanged && !defaultProfileId) {
      toast.error("No profile is available to save the Apify actor selection");
      return false;
    }

    if (
      changedExtractors.length === 0 &&
      changedInstances.length === 0 &&
      !pinsChanged
    ) {
      return true;
    }

    try {
      setIsSaving(true);
      await Promise.all([
        ...changedExtractors.map((extractor) =>
          api.upsertSourceConfig(extractor.extractorId, {
            enabled: pickedExtractors.includes(extractor.extractorId),
          }),
        ),
        ...changedInstances.map((instance) =>
          api.updateProviderInstance(instance.id, {
            enabled: pickedInstances.includes(instance.id),
          }),
        ),
      ]);

      if (pinsChanged && nextPins && defaultProfileId) {
        // A partial `config` is merged field-level server-side, so this cannot
        // drop the profile's other keys — and unlike `buildConfig` it cannot
        // write stale search terms.
        const updated = await api.updateProfile(defaultProfileId, {
          config: { providerInstanceIds: nextPins },
        });
        queryClient.setQueryData<api.ProfilesResponse>(
          queryKeys.profiles.list(),
          (prev) =>
            prev
              ? {
                  ...prev,
                  profiles: prev.profiles.map((profile) =>
                    profile.id === updated.id ? updated : profile,
                  ),
                }
              : prev,
        );
        // `profileForm` is hydrate-once and feeds `buildConfig` on the Search
        // Profile step, which writes `providerInstanceIds` verbatim. Leaving it
        // stale would let a Back-nav + re-save put the OLD pin list back and
        // silently un-pin what we just pinned.
        setProfileForm((prev) =>
          prev ? { ...prev, providerInstanceIds: nextPins } : prev,
        );
      }

      await queryClient.invalidateQueries({
        queryKey: queryKeys.sourceConfigs.all,
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providerInstances.all,
      });
      toast.success("Sources saved");
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save sources",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [
    defaultProfile,
    defaultProfileId,
    extractors,
    instanceEnabledIds,
    instances,
    queryClient,
    sourceEnabledIds,
  ]);

  const handleSaveCvFormat = useCallback(async () => {
    if (cvFormatChoice === null) {
      toast.info("Choose the format your CV is written in to continue");
      return false;
    }
    // The format is write-once server-side: an equal re-write is a no-op and
    // a differing one 409s. Revisiting a settled step must never do either.
    if (storedCvSourceFormat !== null) {
      if (storedCvSourceFormat !== cvFormatChoice) {
        toast.info(
          "The CV format is fixed for this user profile. Create a new user profile to work in the other format.",
        );
      }
      return true;
    }

    try {
      setIsSaving(true);
      const nextSettings = await api.updateSettings({
        cvSourceFormat: cvFormatChoice,
      });
      syncSettingsCache(nextSettings);
      toast.success(
        cvFormatChoice === "docx"
          ? "CV format set to Word"
          : "CV format set to LaTeX",
      );
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save the CV format",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [cvFormatChoice, storedCvSourceFormat, syncSettingsCache]);

  const handleCompleteCv = useCallback(async () => {
    if (cvChoice === null) {
      toast.info("Upload your CV or pick 'Skip for now' to continue");
      return false;
    }
    if (cvChoice === "skip") {
      // Server has nothing to persist for skip; advance.
      return true;
    }
    if (!cvDocument) {
      toast.info("Wait for the upload to finish before continuing");
      return false;
    }
    const nextBrief = getValues().personalBrief;
    if (nextBrief === cvDocument.personalBrief) {
      // No edits → nothing to save, advance.
      return true;
    }
    try {
      setIsSaving(true);
      const updated = await api.updateCvDocument(cvDocument.id, {
        personalBrief: nextBrief,
      });
      setCvDocument(updated);
      setValue("personalBrief", updated.personalBrief, { shouldDirty: false });
      // Search-terms suggestions read from the brief; force the user to
      // re-pull suggestions if they edited the brief after first save.
      markSearchTermsStale();
      queryClient.setQueryData(
        queryKeys.cvDocuments.detail(updated.id),
        updated,
      );
      toast.success("Personal brief saved");
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to save personal brief",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [
    cvChoice,
    cvDocument,
    getValues,
    markSearchTermsStale,
    queryClient,
    setValue,
  ]);

  const handleCompleteBasicAuth = useCallback(async () => {
    if (basicAuthChoice === "skip") {
      try {
        setIsSaving(true);
        const nextSettings = await api.updateSettings({
          onboardingBasicAuthDecision: "skipped",
        });
        syncSettingsCache(nextSettings);
        toast.success("Authentication skipped for now");
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to save onboarding progress",
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    }

    if (basicAuthChoice !== "enable") {
      toast.info("Choose whether to enable authentication or skip it for now");
      return false;
    }

    const { basicAuthUser, basicAuthPassword } = getValues();
    const normalizedUser = basicAuthUser.trim();
    const normalizedPassword = basicAuthPassword.trim();

    if (!normalizedUser || !normalizedPassword) {
      toast.info("Enter both a username and password to enable authentication");
      return false;
    }

    try {
      setIsSaving(true);
      const nextSettings = await api.updateSettings({
        enableBasicAuth: true,
        basicAuthUser: normalizedUser,
        basicAuthPassword: normalizedPassword,
        onboardingBasicAuthDecision: "enabled",
      });
      syncSettingsCache(nextSettings);
      setValue("basicAuthPassword", "");
      toast.success("Authentication enabled");
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to save authentication credentials",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [basicAuthChoice, getValues, setValue, syncSettingsCache]);

  const handlePrimaryAction = useCallback(async () => {
    if (!currentStep) return;
    if (currentStep === "llm") {
      await handleSaveLlm();
      return;
    }
    if (currentStep === "cvformat") {
      await handleSaveCvFormat();
      return;
    }
    if (currentStep === "cv") {
      await handleCompleteCv();
      return;
    }
    if (currentStep === "searchprofile") {
      await handleSaveSearchProfile();
      return;
    }
    if (currentStep === "sources") {
      await handleSaveSources();
      return;
    }
    await handleCompleteBasicAuth();
  }, [
    currentStep,
    handleCompleteBasicAuth,
    handleCompleteCv,
    handleSaveCvFormat,
    handleSaveLlm,
    handleSaveSearchProfile,
    handleSaveSources,
  ]);

  const stepIndex = currentStep
    ? steps.findIndex((step) => step.id === currentStep)
    : 0;
  const canGoBack = stepIndex > 0;
  const isBusy =
    isSaving ||
    settingsLoading ||
    isGeneratingSearchTerms ||
    isValidatingLlm ||
    profilesQuery.isLoading;

  const currentCopy = currentStep ? STEP_COPY[currentStep] : STEP_COPY.llm;

  // The shared field component wants ONE form object, but `searchTerms` lives in
  // react-hook-form (OnboardingPage watches it; the completion flag reads it).
  // Project the two together on the way out; `handleProfileFormChange` splits
  // them again on the way back in.
  //
  // TRAP: `profileForm.searchTerms` is DEAD — it holds whatever was seeded at
  // hydration and is never updated, because RHF owns the terms. It is harmless
  // only because it is always overridden here and spliced explicitly at save.
  // Never call `buildConfig(profileForm)` without splicing RHF's terms in: it
  // would save stale terms, silently, with no type error.
  const searchProfileForm: EditorForm | null = profileForm
    ? {
        ...profileForm,
        searchTerms: watch("searchTerms"),
        searchTermsDraft: watch("searchTermDraft"),
      }
    : null;

  const primaryLabel = resolvePrimaryLabel({
    basicAuthChoice,
    currentStep,
    cvChoice,
    cvFormatChoice,
    cvFormatComplete,
    hasCvDocument: Boolean(cvDocument),
    hasEnabledSource,
    hasSavedSearchTermsInSession,
    llmValidated,
  });

  return {
    apifyProviderId,
    apifyTemplates,
    basicAuthChoice,
    canGoBack,
    complete,
    control,
    currentCopy,
    currentStep,
    cvChoice,
    cvDocument,
    cvFormatChoice,
    extractors,
    hasExistingCv,
    instanceEnabledIds: instanceEnabledIds ?? [],
    instances,
    isBusy,
    isGeneratingSearchTerms,
    hasSavedSearchTermsInSession,
    llmKeyHint,
    llmValidation,
    primaryLabel,
    progressValue,
    searchProfileForm,
    searchTermsSource,
    searchTermsStale,
    selectedProvider,
    settings,
    settingsLoading,
    sourceEnabledIds: sourceEnabledIds ?? [],
    steps,
    storedCvSourceFormat,
    watch,
    setCurrentStep,
    setBasicAuthChoice,
    setCvChoice,
    setCvFormatChoice,
    setCvDocument,
    setValue,
    handleInstanceCreated,
    handleProfileFormChange,
    handleToggleInstance,
    handleToggleSource,
    handleRegenerateSearchTerms: async () => {
      await handleGenerateSearchTerms({ showToast: true });
    },
    handleBack: () => {
      if (!canGoBack) return;
      setCurrentStep(steps[stepIndex - 1]?.id ?? currentStep);
    },
    handlePrimaryAction,
    markSearchTermsStale,
  };
}
