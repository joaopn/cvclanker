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
  LLM_PROVIDER_LABELS,
  LLM_PROVIDERS,
  type LlmProviderId,
  normalizeLlmProvider,
} from "@client/pages/settings/utils";
import { getDefaultModelForProvider } from "@shared/settings-registry";
import type { UpdateSettingsInput } from "@shared/settings-schema.js";
import type {
  AppSettings,
  CvDocument,
  CvDocumentSummary,
  LlmProviderCredentialSummary,
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
  ConfiguredLlmProvider,
  CvChoice,
  CvFormatChoice,
  LlmStepModel,
  LlmTestResult,
  OnboardingFormData,
  OnboardingStep,
  StepId,
  ValidationState,
} from "./types";

/**
 * The "Configured providers" rows: the app's provider first when one is in use,
 * then every other provider with something stored — a credentials row with a
 * key or a base URL, a Claude Code token, or a Codex sign-in.
 */
function listConfiguredLlmProviders(args: {
  appProvider: LlmProviderId;
  appProviderInUse: boolean;
  appBaseUrl: string;
  claudeCodeTokenHint: string | null;
  codexSignedIn: boolean;
  credentials: LlmProviderCredentialSummary[];
  llmKeyHint: string | null;
}): ConfiguredLlmProvider[] {
  const rows: ConfiguredLlmProvider[] = [];
  const loginDetails = (provider: LlmProviderId): string[] => [
    ...(provider === "claude_code" && args.claudeCodeTokenHint
      ? ["Token saved"]
      : []),
    ...(provider === "codex" && args.codexSignedIn ? ["Signed in"] : []),
  ];

  if (args.appProviderInUse) {
    const config = getLlmProviderConfig(args.appProvider);
    rows.push({
      provider: args.appProvider,
      usedByApp: true,
      details: [
        ...(config.showApiKey && args.llmKeyHint
          ? [`API key ${args.llmKeyHint}********`]
          : []),
        ...(config.showBaseUrl && args.appBaseUrl ? [args.appBaseUrl] : []),
        ...loginDetails(args.appProvider),
      ],
    });
  }

  for (const provider of LLM_PROVIDERS) {
    if (rows.some((row) => row.provider === provider)) continue;
    const saved = args.credentials.find((entry) => entry.provider === provider);
    const details = [
      ...(saved?.apiKeyHint ? [`API key ${saved.apiKeyHint}********`] : []),
      ...(saved?.baseUrl ? [saved.baseUrl] : []),
      ...loginDetails(provider),
    ];
    if (details.length > 0) rows.push({ provider, usedByApp: false, details });
  }
  return rows;
}

/**
 * After Remove wrote its nulls, whether the provider is still the app's — set
 * by the server's environment, which a null restores and the UI cannot clear.
 */
function isStillAppProvider(
  next: AppSettings,
  provider: LlmProviderId,
): boolean {
  if (normalizeLlmProvider(next.llmProvider?.value) !== provider) return false;
  const config = getLlmProviderConfig(provider);
  return Boolean(
    (config.showApiKey && next.llmApiKeyHint) ||
      (config.showBaseUrl && next.llmBaseUrl?.value) ||
      (provider === "claude_code" && next.claudeCodeOauthTokenHint),
  );
}

function resolvePrimaryLabel(args: {
  basicAuthChoice: BasicAuthChoice;
  currentStep: StepId | null;
  cvChoice: CvChoice;
  cvFormatChoice: CvFormatChoice;
  cvFormatComplete: boolean;
  hasCvDocument: boolean;
  hasEnabledSource: boolean;
  hasSavedSearchTermsInSession: boolean;
  llmChecking: boolean;
  llmProviderInUse: boolean;
  llmValidated: boolean;
}): string {
  if (args.currentStep === "llm") {
    if (args.llmValidated) return "Continue";
    if (args.llmChecking && args.llmProviderInUse) {
      return "Checking the provider…";
    }
    return args.llmProviderInUse
      ? "Fix the provider to continue"
      : "Add a provider to continue";
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
  const [isTestingLlm, setIsTestingLlm] = useState(false);
  const [isGeneratingSearchTerms, setIsGeneratingSearchTerms] = useState(false);
  const [llmValidation, setLlmValidation] = useState<ValidationState>(
    EMPTY_VALIDATION_STATE,
  );
  // The provider the last saved-configuration check was for. A result only
  // counts for the provider it checked, so neither a check that lands late
  // nor the render between a provider change and the reset effect can mark a
  // different provider as working.
  const [llmValidationFor, setLlmValidationFor] =
    useState<LlmProviderId | null>(null);
  const llmCheckRequestRef = useRef(0);
  const [llmTestResult, setLlmTestResult] = useState<LlmTestResult | null>(
    null,
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
        claudeCodeOauthToken: "",
        personalBrief: "",

        searchTerms: [],
        searchTermDraft: "",
        basicAuthUser: "",
        basicAuthPassword: "",
        candidateName: "",
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
    const current = getValues();
    reset({
      // The LLM fields are the "Add provider" box's drafts, never the stored
      // provider: what is stored is shown under "Configured providers".
      llmProvider: current.llmProvider,
      llmBaseUrl: current.llmBaseUrl,
      llmApiKey: current.llmApiKey,
      claudeCodeOauthToken: current.claudeCodeOauthToken,
      personalBrief: "",
      searchTerms: current.searchTerms,

      searchTermDraft: "",
      basicAuthUser: settings.basicAuthUser ?? "",
      basicAuthPassword: "",
      candidateName: settings.candidateName?.value ?? "",
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

  const credentialsQuery = useQuery({
    queryKey: queryKeys.llmProviderCredentials.all,
    queryFn: api.getLlmProviderCredentials,
  });
  // The status check runs the Codex CLI, so it is fetched once; the sign-in
  // panel and Remove write every later change into the cache.
  const codexStatusQuery = useQuery({
    queryKey: queryKeys.codexAuth.status(),
    queryFn: api.getCodexAuthStatus,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const credentials = credentialsQuery.data ?? [];
  const codexSignedIn = codexStatusQuery.data?.authenticated ?? false;

  // The app's provider is the stored settings trio, which every ordinary LLM
  // call reads; other providers live in `llm_provider_credentials`.
  const appProvider = normalizeLlmProvider(settings?.llmProvider?.value);
  const appProviderConfig = getLlmProviderConfig(appProvider);
  const llmKeyHint = settings?.llmApiKeyHint ?? null;
  const claudeCodeTokenHint = settings?.claudeCodeOauthTokenHint ?? null;
  const appBaseUrl = settings?.llmBaseUrl?.value || "";

  const appCheck =
    llmValidationFor === appProvider ? llmValidation : EMPTY_VALIDATION_STATE;
  const llmValidated = appCheck.valid;
  const appProviderInUse =
    Boolean(settings?.llmProvider?.override) ||
    llmValidated ||
    (appProviderConfig.showApiKey && Boolean(llmKeyHint)) ||
    (appProviderConfig.showBaseUrl && Boolean(appBaseUrl)) ||
    (appProvider === "claude_code" && Boolean(claudeCodeTokenHint)) ||
    (appProvider === "codex" && codexSignedIn);

  const configuredLlmProviders = listConfiguredLlmProviders({
    appProvider,
    appProviderInUse,
    appBaseUrl,
    claudeCodeTokenHint,
    codexSignedIn,
    credentials,
    llmKeyHint,
  });

  // While no provider is in use, Add makes the picked one the app's provider,
  // so every provider is offered — one already configured as an extra
  // included. Once one is in use, Add adds the providers not configured yet.
  const addableLlmProviders = appProviderInUse
    ? LLM_PROVIDERS.filter(
        (provider) =>
          !configuredLlmProviders.some((row) => row.provider === provider),
      )
    : [...LLM_PROVIDERS];
  const draftLlmProvider = watch("llmProvider");
  const addLlmProvider: LlmProviderId | null =
    addableLlmProviders.find((provider) => provider === draftLlmProvider) ??
    (addableLlmProviders.includes(appProvider)
      ? appProvider
      : (addableLlmProviders[0] ?? null));
  const addLlmConfig = addLlmProvider
    ? getLlmProviderConfig(addLlmProvider)
    : null;
  const draftApiKey = watch("llmApiKey").trim();
  const draftBaseUrl = watch("llmBaseUrl").trim();
  const draftToken = watch("claudeCodeOauthToken").trim();

  // Ollama and LM Studio take no key, and the check route then falls back to
  // the stored key whatever the provider (B99's server half), sending it to
  // the typed URL. So they are not tested while a key belongs to another
  // provider.
  const testDisabledReason =
    addLlmProvider &&
    addLlmConfig &&
    !addLlmConfig.showApiKey &&
    addLlmConfig.showBaseUrl &&
    llmKeyHint &&
    addLlmProvider !== appProvider
      ? `Test is unavailable for ${addLlmConfig.label} while another provider's API key is saved: the check would send that key along.`
      : null;
  // OpenAI-compatible with no URL would be checked against the server's
  // default endpoint, sending the typed token to OpenAI.
  const canTestLlm = Boolean(
    addLlmConfig &&
      (!addLlmConfig.showApiKey || draftApiKey) &&
      (addLlmProvider !== "openai_compatible" || draftBaseUrl) &&
      !testDisabledReason,
  );
  let addLlmDisabledReason: string | null = null;
  if (!addLlmProvider || !addLlmConfig) {
    addLlmDisabledReason = "Every provider has been added.";
  } else if (addLlmConfig.showApiKey && !draftApiKey) {
    addLlmDisabledReason = `Paste the ${addLlmConfig.label} API key to add it.`;
  } else if (addLlmProvider === "codex" && !codexSignedIn) {
    addLlmDisabledReason = appProviderInUse
      ? "Sign in to Codex above: signing in adds it."
      : "Sign in to Codex above to add it.";
  } else if (
    addLlmProvider === "claude_code" &&
    !draftToken &&
    (appProviderInUse || !claudeCodeTokenHint)
  ) {
    addLlmDisabledReason = "Paste a Claude Code token to add it.";
  } else if (
    addLlmConfig.showBaseUrl &&
    !draftBaseUrl &&
    (appProviderInUse || addLlmProvider === "openai_compatible")
  ) {
    addLlmDisabledReason = `Enter the ${addLlmConfig.label} base URL to add it.`;
  }

  // What is typed belongs to the provider it was typed for. The picked
  // provider also changes without the user (one they were adding becomes
  // configured and leaves the list), so this keys on the provider, not on
  // the dropdown's onChange.
  useEffect(() => {
    void addLlmProvider;
    setValue("llmApiKey", "");
    setValue("llmBaseUrl", "");
    setValue("claudeCodeOauthToken", "");
  }, [addLlmProvider, setValue]);
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

  // The check of the SAVED configuration: no key or base URL is sent, so the
  // server uses what is stored — which belongs to this provider. It runs on
  // mount, whenever the app's provider changes, and whenever the settings
  // object changes (the reset effect above empties the validation), which is
  // how an Add or a Remove re-checks the app's provider.
  // Only the latest check writes its result and its provider, and clears the
  // busy flag: a settings change can start one while another is running.
  const checkAppProvider = useCallback(async () => {
    const request = ++llmCheckRequestRef.current;
    const provider = appProvider;
    setIsValidatingLlm(true);
    let state: ValidationState;
    try {
      state = toValidationState(await api.validateLlm({ provider }));
    } catch (error) {
      state = toValidationState({
        valid: false,
        message:
          error instanceof Error ? error.message : "LLM validation failed",
      });
    }
    if (request !== llmCheckRequestRef.current) return;
    setLlmValidation(state);
    setLlmValidationFor(provider);
    setIsValidatingLlm(false);
  }, [appProvider, toValidationState]);

  useEffect(() => {
    if (!settings || settingsLoading) return;
    if (appCheck.hydrated) return;
    void checkAppProvider();
  }, [appCheck.hydrated, checkAppProvider, settings, settingsLoading]);

  // A Codex sign-in or sign-out changes no setting, so the reset effect never
  // sees it; re-check when it happens while the app runs on Codex. The check
  // is started directly, because a check already running (its state already
  // empty) would otherwise finish with a result taken before the change. The
  // status query's first answer is not a change: the mount check covers it.
  const codexAuthenticated = codexStatusQuery.data?.authenticated;
  const codexAuthenticatedRef = useRef(codexAuthenticated);
  useEffect(() => {
    const previous = codexAuthenticatedRef.current;
    if (previous === codexAuthenticated) return;
    codexAuthenticatedRef.current = codexAuthenticated;
    if (previous === undefined) return;
    if (appProvider !== "codex" || !settings || settingsLoading) return;
    void checkAppProvider();
  }, [
    appProvider,
    checkAppProvider,
    codexAuthenticated,
    settings,
    settingsLoading,
  ]);

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
        subtitle: "Sign-in, your name and appearance",
        // Keyed on the basic-auth decision ALONE. The name on this step is
        // optional, and the theme is a per-device localStorage preference with
        // no server-side value to check; gating on either would push existing
        // installs back through onboarding.
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

  const handleSelectLlmProvider = useCallback(
    (provider: LlmProviderId) => {
      setValue("llmProvider", provider);
      setLlmTestResult(null);
    },
    [setValue],
  );

  // Test checks what is typed and saves nothing — except a Claude Code token:
  // that check asks the CLI, which reads the token from the server's
  // environment, so the token is saved first or the check runs without it.
  // The check route falls back to the stored key and URL when none is sent,
  // so a key provider is only tested with a typed key, a base-URL provider
  // always sends the typed URL (empty means the provider's default), and
  // `testDisabledReason` covers Ollama and LM Studio, which send no key.
  const handleTestLlmProvider = useCallback(async () => {
    if (!addLlmProvider || !canTestLlm) return;
    const config = getLlmProviderConfig(addLlmProvider);
    const values = getValues();
    const token = values.claudeCodeOauthToken.trim();

    setIsTestingLlm(true);
    setLlmTestResult(null);
    try {
      if (addLlmProvider === "claude_code" && token) {
        const nextSettings = await api.updateSettings({
          claudeCodeOauthToken: token,
        });
        syncSettingsCache(nextSettings);
        setValue("claudeCodeOauthToken", "");
      }
      const result = await api.validateLlm({
        provider: addLlmProvider,
        apiKey: config.showApiKey ? values.llmApiKey.trim() : undefined,
        baseUrl: config.showBaseUrl ? values.llmBaseUrl.trim() : undefined,
      });
      setLlmTestResult({ ...result, provider: addLlmProvider });
    } catch (error) {
      setLlmTestResult({
        provider: addLlmProvider,
        valid: false,
        message:
          error instanceof Error ? error.message : "The connection test failed",
      });
    } finally {
      setIsTestingLlm(false);
    }
  }, [addLlmProvider, canTestLlm, getValues, setValue, syncSettingsCache]);

  // Add saves what is typed, with no check. While no provider is in use it
  // writes the settings trio, making the provider the app's (the reset effect
  // then re-checks it); otherwise it stores the provider as an extra.
  const handleAddLlmProvider = useCallback(async () => {
    if (!addLlmProvider) return;
    if (addLlmDisabledReason) {
      toast.info(addLlmDisabledReason);
      return;
    }
    const config = getLlmProviderConfig(addLlmProvider);
    const values = getValues();
    const apiKey = values.llmApiKey.trim();
    const baseUrl = values.llmBaseUrl.trim();
    const token = values.claudeCodeOauthToken.trim();

    try {
      setIsSaving(true);
      if (!appProviderInUse) {
        const update: Partial<UpdateSettingsInput> = {
          llmProvider: addLlmProvider,
          llmBaseUrl: config.showBaseUrl ? baseUrl || null : null,
          model: null,
          modelScorer: null,
          modelTailoring: null,
        };
        // A provider without a key field clears the stored key, or its own
        // check would send a previous provider's key along.
        update.llmApiKey = config.showApiKey ? apiKey : null;
        if (addLlmProvider === "claude_code" && token) {
          update.claudeCodeOauthToken = token;
        }
        const nextSettings = await api.updateSettings(update);
        syncSettingsCache(nextSettings);
        try {
          const nextCredentials =
            await api.deleteLlmProviderCredential(addLlmProvider);
          queryClient.setQueryData(
            queryKeys.llmProviderCredentials.all,
            nextCredentials,
          );
        } catch (error) {
          toast.error(
            `${config.label} was added, but its older saved credential could not be removed${
              error instanceof Error ? `: ${error.message}` : ""
            }`,
          );
        }
        const defaultModel = getDefaultModelForProvider(addLlmProvider);
        toast.success(`${config.label} added — the app runs on it`, {
          description:
            addLlmProvider === "openai" || addLlmProvider === "gemini"
              ? `Default for ${config.label}: ${defaultModel}.`
              : "You can fine-tune models later in Settings.",
        });
      } else if (addLlmProvider === "claude_code") {
        const nextSettings = await api.updateSettings({
          claudeCodeOauthToken: token,
        });
        syncSettingsCache(nextSettings);
        toast.success(`${config.label} added`);
      } else {
        const nextCredentials = await api.saveLlmProviderCredential(
          addLlmProvider,
          {
            ...(config.showApiKey ? { apiKey } : {}),
            ...(config.showBaseUrl ? { baseUrl } : {}),
          },
        );
        queryClient.setQueryData(
          queryKeys.llmProviderCredentials.all,
          nextCredentials,
        );
        toast.success(`${config.label} added`);
      }
      setValue("llmProvider", "");
      setValue("llmApiKey", "");
      setValue("llmBaseUrl", "");
      setValue("claudeCodeOauthToken", "");
      setLlmTestResult(null);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to add the provider",
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    addLlmDisabledReason,
    addLlmProvider,
    appProviderInUse,
    getValues,
    queryClient,
    setValue,
    syncSettingsCache,
  ]);

  // Remove deletes everything stored for the provider. On the app's provider
  // that is the settings trio (and the Claude Code token), so the step goes
  // back to incomplete and the next Add becomes the app's provider; the
  // other providers are left alone. The app's provider's own credentials row
  // is deleted even when the list failed to load (the route accepts a
  // missing row), or it would come back as an extra.
  const handleRemoveLlmProvider = useCallback(
    async (provider: LlmProviderId) => {
      const row = configuredLlmProviders.find(
        (entry) => entry.provider === provider,
      );
      if (!row) return;
      try {
        setIsSaving(true);
        let nextSettings: AppSettings | null = null;
        if (row.usedByApp) {
          const update: Partial<UpdateSettingsInput> = {
            llmProvider: null,
            llmApiKey: null,
            llmBaseUrl: null,
          };
          if (provider === "claude_code") update.claudeCodeOauthToken = null;
          nextSettings = await api.updateSettings(update);
          syncSettingsCache(nextSettings);
        } else if (provider === "claude_code") {
          nextSettings = await api.updateSettings({
            claudeCodeOauthToken: null,
          });
          syncSettingsCache(nextSettings);
        }
        if (provider === "codex" && codexSignedIn) {
          const status = await api.disconnectCodexAuth();
          queryClient.setQueryData(queryKeys.codexAuth.status(), status);
        }
        if (
          row.usedByApp ||
          credentials.some((entry) => entry.provider === provider)
        ) {
          const nextCredentials =
            await api.deleteLlmProviderCredential(provider);
          queryClient.setQueryData(
            queryKeys.llmProviderCredentials.all,
            nextCredentials,
          );
        }
        const label = LLM_PROVIDER_LABELS[provider];
        const tokenFromEnvironment =
          provider === "claude_code" &&
          Boolean(nextSettings?.claudeCodeOauthTokenHint);
        if (
          (row.usedByApp &&
            nextSettings &&
            isStillAppProvider(nextSettings, provider)) ||
          (!row.usedByApp && tokenFromEnvironment)
        ) {
          toast.info(
            `${label} is set by the server's environment, so it cannot be removed here.`,
          );
        } else if (tokenFromEnvironment) {
          toast.info(
            `${label} no longer runs the app, but its token comes from the server's environment, so it stays listed.`,
          );
        } else {
          toast.success(`${label} removed`);
        }
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to remove the provider",
        );
      } finally {
        setIsSaving(false);
      }
    },
    [
      codexSignedIn,
      configuredLlmProviders,
      credentials,
      queryClient,
      syncSettingsCache,
    ],
  );

  const handleCodexStatusChange = useCallback(
    (status: api.CodexAuthStatusResponse) => {
      queryClient.setQueryData(queryKeys.codexAuth.status(), status);
    },
    [queryClient],
  );

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
    const candidateName = getValues().candidateName.trim() || null;
    if (basicAuthChoice === "skip") {
      try {
        setIsSaving(true);
        const nextSettings = await api.updateSettings({
          onboardingBasicAuthDecision: "skipped",
          candidateName,
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
        candidateName,
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
      if (!llmValidated) {
        toast.info(
          appProviderInUse
            ? "The provider the app uses did not pass its check — see Configured providers"
            : "Add a provider to continue",
        );
        return;
      }
      const next = steps[steps.findIndex((step) => step.id === "llm") + 1];
      if (next) setCurrentStep(next.id);
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
    appProviderInUse,
    currentStep,
    handleCompleteBasicAuth,
    handleCompleteCv,
    handleSaveCvFormat,
    handleSaveSearchProfile,
    handleSaveSources,
    llmValidated,
    steps,
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
    isTestingLlm ||
    credentialsQuery.isLoading ||
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
    llmChecking: isValidatingLlm,
    llmProviderInUse: appProviderInUse,
    llmValidated,
  });

  const llmStep: LlmStepModel = {
    addProvider: addLlmProvider,
    addableProviders: addableLlmProviders,
    addMakesAppProvider: !appProviderInUse,
    addDisabledReason: addLlmDisabledReason,
    canTest: canTestLlm,
    testDisabledReason,
    claudeCodeTokenHint,
    codexSignedIn,
    configuredProviders: configuredLlmProviders,
    isTesting: isTestingLlm,
    isValidating: isValidatingLlm,
    testResult: llmTestResult,
    validation: appCheck,
    onSelectProvider: handleSelectLlmProvider,
    onTest: handleTestLlmProvider,
    onAdd: handleAddLlmProvider,
    onRemove: handleRemoveLlmProvider,
    onCodexStatusChange: handleCodexStatusChange,
  };

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
    llmStep,
    primaryLabel,
    progressValue,
    searchProfileForm,
    searchTermsSource,
    searchTermsStale,
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
