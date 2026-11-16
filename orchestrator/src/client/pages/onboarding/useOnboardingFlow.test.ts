import type { SourceConfigsExtractorEntry } from "@client/api";
import { renderHookWithQueryClient } from "@client/test/renderWithQueryClient";
import { createAppSettings } from "@shared/testing/factories";
import type {
  AppSettings,
  CvDocument,
  Profile,
  ProviderInstanceRow,
} from "@shared/types";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  getSettings: vi.fn(),
  getProfiles: vi.fn(),
  getSourceConfigs: vi.fn(),
  getProviderInstances: vi.fn(),
  listCvDocuments: vi.fn(),
  getCvDocument: vi.fn(),
  validateLlm: vi.fn(),
  suggestOnboardingSearchTerms: vi.fn(),
  updateProfile: vi.fn(),
  updateProviderInstance: vi.fn(),
  upsertSourceConfig: vi.fn(),
  updateSettings: vi.fn(),
  updateCvDocument: vi.fn(),
  getLlmProviderCredentials: vi.fn(() => Promise.resolve([])),
  saveLlmProviderCredential: vi.fn(),
  deleteLlmProviderCredential: vi.fn(),
  getCodexAuthStatus: vi.fn(() => Promise.resolve({ authenticated: false })),
  disconnectCodexAuth: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  type CodexAuthStatusResponse,
  deleteLlmProviderCredential,
  disconnectCodexAuth,
  getCodexAuthStatus,
  getCvDocument,
  getLlmProviderCredentials,
  getProfiles,
  getProviderInstances,
  getSettings,
  getSourceConfigs,
  listCvDocuments,
  saveLlmProviderCredential,
  suggestOnboardingSearchTerms,
  updateProfile,
  updateProviderInstance,
  updateSettings,
  validateLlm,
} from "@client/api";
import { toast } from "@client/lib/toast";
import { useOnboardingFlow } from "./useOnboardingFlow";

function makeProfile(
  searchTerms: string[],
  providerInstanceIds: string[] = [],
): Profile {
  return {
    id: "p1",
    name: "Default",
    config: {
      searchTerms,
      searchCountry: "",
      searchCities: "",
      workplaceTypes: ["remote"],
      locationSearchScope: "selected_only",
      locationMatchStrictness: "exact_only",
      remoteProfile: false,
      remoteLocationBlocklist: [],
      scrapeMaxAgeDays: null,
      scrapeSinceLastRun: false,
      blockedCompanyKeywords: [],
      runBudget: 500,
      termJobBudget: 100,
      termJobBudgets: {},
      topN: 10,
      minSuitabilityCategory: "good_fit",
      enabledSourceIds: ["jobspy"],
      providerInstanceIds,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeExtractorEntry(): SourceConfigsExtractorEntry {
  return {
    extractorId: "jobspy",
    displayName: "JobSpy",
    providesSources: [],
    row: {
      extractorId: "jobspy",
      enabled: true,
      config: {},
      mappings: {},
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    schema: null,
    effectiveSettings: {},
  };
}

function makeInstance(enabled: boolean): ProviderInstanceRow {
  return {
    id: "i1",
    providerId: "apify",
    templateId: null,
    label: "LinkedIn (Apify)",
    actorRef: "curious_coder/linkedin-jobs-scraper",
    enabled,
    inputTemplateJson: "{}",
    outputMappingJson: "{}",
    mappings: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function apifyProviders(instances: ProviderInstanceRow[]) {
  return {
    providers: [
      {
        id: "apify",
        displayName: "Apify",
        templates: [],
        instances,
      },
    ],
  };
}

const CV = {
  id: "cv1",
  name: "CV",
  personalBrief: "I am a…",
  fields: [],
} as unknown as CvDocument;

/** Drive the hook to the search-profile step, where the auto-suggest fires. */
async function renderAtSearchProfile() {
  const rendered = renderHookWithQueryClient(() => useOnboardingFlow());
  await act(async () => {
    rendered.result.current.setCurrentStep("searchprofile");
  });
  return rendered;
}

describe("useOnboardingFlow — search terms auto-filled from the CV", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockResolvedValue(createAppSettings());
    vi.mocked(getSourceConfigs).mockResolvedValue({ extractors: [] });
    vi.mocked(getProviderInstances).mockResolvedValue({ providers: [] });
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    vi.mocked(listCvDocuments).mockResolvedValue([
      { id: "cv1" } as unknown as Awaited<
        ReturnType<typeof listCvDocuments>
      >[number],
    ]);
    vi.mocked(getCvDocument).mockResolvedValue(CV);
    vi.mocked(suggestOnboardingSearchTerms).mockResolvedValue({
      terms: ["ml engineer", "data scientist"],
      source: "ai",
    });
  });

  it("does NOT suggest while the profiles query is still pending", async () => {
    // THE REGRESSION GUARD. `defaultProfileTerms` falls back to `[]` on pending
    // data, so "no saved terms" is a false positive here. Firing now would land
    // a suggestion that the profile-seed effect then wipes on first arrival —
    // silently, and only on a fresh install.
    vi.mocked(getProfiles).mockReturnValue(new Promise(() => {}));

    const { result } = await renderAtSearchProfile();

    await waitFor(() => expect(result.current.cvDocument).not.toBeNull());
    expect(suggestOnboardingSearchTerms).not.toHaveBeenCalled();
  });

  it("suggests once when the profile has no terms, and the terms survive", async () => {
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile([])],
      defaultProfileId: "p1",
    });

    const { result } = await renderAtSearchProfile();

    await waitFor(() =>
      expect(suggestOnboardingSearchTerms).toHaveBeenCalledTimes(1),
    );

    await waitFor(() =>
      expect(result.current.watch("searchTerms")).toEqual([
        "ml engineer",
        "data scientist",
      ]),
    );
    // The seed effect nulls `searchTermsSource` on its first-arrival run; if it
    // clobbered the suggestion, the provenance alert would vanish too.
    expect(result.current.searchTermsSource).toBe("ai");
  });

  it("does NOT suggest when the profile already has terms", async () => {
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile(["existing role"])],
      defaultProfileId: "p1",
    });

    const { result } = await renderAtSearchProfile();

    await waitFor(() =>
      expect(result.current.watch("searchTerms")).toEqual(["existing role"]),
    );
    expect(suggestOnboardingSearchTerms).not.toHaveBeenCalled();
  });

  it("does NOT suggest when there is no CV", async () => {
    // The suggester 409s without a resume; a CV-skipping user must not eat an
    // error toast on step entry.
    vi.mocked(listCvDocuments).mockResolvedValue([]);
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile([])],
      defaultProfileId: "p1",
    });

    const { result } = await renderAtSearchProfile();

    await waitFor(() => expect(result.current.steps.length).toBe(6));
    expect(suggestOnboardingSearchTerms).not.toHaveBeenCalled();
  });
});

describe("useOnboardingFlow — basic auth default", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSourceConfigs).mockResolvedValue({ extractors: [] });
    vi.mocked(getProviderInstances).mockResolvedValue({ providers: [] });
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    vi.mocked(listCvDocuments).mockResolvedValue([]);
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile([])],
      defaultProfileId: "p1",
    });
  });

  it("defaults to skip on a fresh install", async () => {
    // The settings-reset effect re-seeds this on the first settings load, so
    // the useState initializer alone is not enough — both must say "skip".
    vi.mocked(getSettings).mockResolvedValue(createAppSettings());

    const { result } = renderHookWithQueryClient(() => useOnboardingFlow());

    await waitFor(() => expect(result.current.settings).not.toBeNull());
    expect(result.current.basicAuthChoice).toBe("skip");
  });

  it("still selects enable when auth is already active", async () => {
    vi.mocked(getSettings).mockResolvedValue(
      createAppSettings({ basicAuthActive: true }),
    );

    const { result } = renderHookWithQueryClient(() => useOnboardingFlow());

    await waitFor(() => expect(result.current.settings).not.toBeNull());
    expect(result.current.basicAuthChoice).toBe("enable");
  });
});

describe("useOnboardingFlow — saving the sources step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockResolvedValue(createAppSettings());
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    vi.mocked(listCvDocuments).mockResolvedValue([]);
    vi.mocked(getSourceConfigs).mockResolvedValue({
      extractors: [makeExtractorEntry()],
    });
    vi.mocked(updateProviderInstance).mockResolvedValue(makeInstance(true));
  });

  async function renderAtSources() {
    const rendered = renderHookWithQueryClient(() => useOnboardingFlow());
    await waitFor(() =>
      expect(rendered.result.current.sourceEnabledIds).toEqual(["jobspy"]),
    );
    await act(async () => {
      rendered.result.current.setCurrentStep("sources");
    });
    return rendered;
  }

  it("enables a ticked actor AND pins it into the default Search Profile", async () => {
    // Both levels, or the actor is inert: a source runs only when it is enabled
    // on the User Profile AND pinned in the Search Profile, and Apify pins are
    // never backfilled.
    vi.mocked(getProviderInstances).mockResolvedValue(
      apifyProviders([makeInstance(false)]),
    );
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile(["role"])],
      defaultProfileId: "p1",
    });
    vi.mocked(updateProfile).mockResolvedValue(makeProfile(["role"], ["i1"]));

    const { result } = await renderAtSources();

    await act(async () => {
      result.current.handleToggleInstance("i1", true);
    });
    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(updateProviderInstance).toHaveBeenCalledWith("i1", {
      enabled: true,
    });
    expect(updateProfile).toHaveBeenCalledWith("p1", {
      config: { providerInstanceIds: ["i1"] },
    });
  });

  it("pins an actor created in the wizard, before the instances query refetches it", async () => {
    // The dialog invalidates the instances query WITHOUT awaiting it, so the new
    // actor sits in the tick list while `instances` still lacks it. Filtering the
    // pin set against `instances` would drop the pin of the very actor the user
    // just added — enabled, unpinned, silently never run.
    vi.mocked(getProviderInstances).mockResolvedValue(apifyProviders([]));
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile(["role"])],
      defaultProfileId: "p1",
    });
    vi.mocked(updateProfile).mockResolvedValue(makeProfile(["role"], ["i1"]));

    const { result } = await renderAtSources();

    await act(async () => {
      result.current.handleInstanceCreated(makeInstance(true));
    });
    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(updateProfile).toHaveBeenCalledWith("p1", {
      config: { providerInstanceIds: ["i1"] },
    });
  });

  it("drops the pin of an actor the user un-ticks (the pin write is authoritative)", async () => {
    vi.mocked(getProviderInstances).mockResolvedValue(
      apifyProviders([makeInstance(true)]),
    );
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile(["role"], ["i1"])],
      defaultProfileId: "p1",
    });
    vi.mocked(updateProfile).mockResolvedValue(makeProfile(["role"], []));
    vi.mocked(updateProviderInstance).mockResolvedValue(makeInstance(false));

    const { result } = await renderAtSources();
    await waitFor(() =>
      expect(result.current.instanceEnabledIds).toEqual(["i1"]),
    );

    await act(async () => {
      result.current.handleToggleInstance("i1", false);
    });
    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(updateProviderInstance).toHaveBeenCalledWith("i1", {
      enabled: false,
    });
    expect(updateProfile).toHaveBeenCalledWith("p1", {
      config: { providerInstanceIds: [] },
    });
  });

  it("saves what the step shows: a ticked actor is pinned even if the user did not toggle it", async () => {
    // What the wizard shows IS what gets written. An enabled actor hydrates
    // TICKED, so saving the step pins it — the step's state is the source of
    // truth for the default profile's actor pins.
    vi.mocked(getProviderInstances).mockResolvedValue(
      apifyProviders([makeInstance(true)]),
    );
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile(["role"])],
      defaultProfileId: "p1",
    });
    vi.mocked(updateProfile).mockResolvedValue(makeProfile(["role"], ["i1"]));

    const { result } = await renderAtSources();
    await waitFor(() =>
      expect(result.current.instanceEnabledIds).toEqual(["i1"]),
    );

    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(updateProfile).toHaveBeenCalledWith("p1", {
      config: { providerInstanceIds: ["i1"] },
    });
    // Already enabled — no redundant instance write.
    expect(updateProviderInstance).not.toHaveBeenCalled();
  });

  it("refuses the whole save when no profile is available to pin into", async () => {
    // Writing the instance enable without the pin would leave the actor
    // enabled-but-unpinned — configured in the UI, absent from every run — under
    // a green "Sources saved" toast. Refuse before ANY write instead.
    vi.mocked(getProviderInstances).mockResolvedValue(
      apifyProviders([makeInstance(false)]),
    );
    vi.mocked(getProfiles).mockReturnValue(new Promise(() => {}));

    const { result } = await renderAtSources();
    await waitFor(() => expect(result.current.instanceEnabledIds).toEqual([]));

    await act(async () => {
      result.current.handleToggleInstance("i1", true);
    });
    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(updateProviderInstance).not.toHaveBeenCalled();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("never writes pins from an unhydrated tick list", async () => {
    // With the instances query in flight the tick list is null; treating that as
    // "nothing ticked" would un-pin actors the step never rendered.
    vi.mocked(getProviderInstances).mockReturnValue(new Promise(() => {}));
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile(["role"], ["i1"])],
      defaultProfileId: "p1",
    });

    const { result } = await renderAtSources();

    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(updateProfile).not.toHaveBeenCalled();
    expect(updateProviderInstance).not.toHaveBeenCalled();
  });
});

describe("useOnboardingFlow — the candidate name on the final step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSourceConfigs).mockResolvedValue({ extractors: [] });
    vi.mocked(getProviderInstances).mockResolvedValue({ providers: [] });
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    vi.mocked(listCvDocuments).mockResolvedValue([]);
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile([])],
      defaultProfileId: "p1",
    });
    vi.mocked(updateSettings).mockResolvedValue(createAppSettings());
  });

  async function renderAtFinalize(storedName: string | null = null) {
    vi.mocked(getSettings).mockResolvedValue(
      createAppSettings({
        candidateName: {
          value: storedName,
          default: null,
          override: storedName,
        },
      }),
    );
    const rendered = renderHookWithQueryClient(() => useOnboardingFlow());
    await waitFor(() =>
      expect(rendered.result.current.settings).not.toBeNull(),
    );
    await act(async () => {
      rendered.result.current.setCurrentStep("finalize");
    });
    return rendered;
  }

  it("seeds the field from the stored name", async () => {
    const { result } = await renderAtFinalize("Jane Q. Doe");

    expect(result.current.watch("candidateName")).toBe("Jane Q. Doe");
  });

  it("saves the trimmed name with a skipped auth decision", async () => {
    const { result } = await renderAtFinalize();

    await act(async () => {
      result.current.setValue("candidateName", "  Jane Q. Doe ");
    });
    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(vi.mocked(updateSettings).mock.calls).toStrictEqual([
      [
        {
          onboardingBasicAuthDecision: "skipped",
          candidateName: "Jane Q. Doe",
        },
      ],
    ]);
  });

  it("clears the name when the field is left blank", async () => {
    const { result } = await renderAtFinalize("Jane Q. Doe");

    await act(async () => {
      result.current.setValue("candidateName", "   ");
    });
    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(vi.mocked(updateSettings).mock.calls).toStrictEqual([
      [{ onboardingBasicAuthDecision: "skipped", candidateName: null }],
    ]);
  });

  it("saves the name in the same request as enabled auth", async () => {
    const { result } = await renderAtFinalize();

    await act(async () => {
      result.current.setBasicAuthChoice("enable");
      result.current.setValue("basicAuthUser", "admin");
      result.current.setValue("basicAuthPassword", "secret");
      result.current.setValue("candidateName", "Ana Silva");
    });
    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(vi.mocked(updateSettings).mock.calls).toStrictEqual([
      [
        {
          enableBasicAuth: true,
          basicAuthUser: "admin",
          basicAuthPassword: "secret",
          onboardingBasicAuthDecision: "enabled",
          candidateName: "Ana Silva",
        },
      ],
    ]);
  });
});

describe("useOnboardingFlow — the LLM step's Add provider and Configured providers", () => {
  /** Settings with `provider` stored as the app's provider (an override). */
  function storedSettings(
    provider: string | null,
    extra: Partial<AppSettings> = {},
  ): AppSettings {
    return createAppSettings({
      llmProvider: {
        value: provider ?? "openrouter",
        default: "openrouter",
        override: provider,
      },
      llmBaseUrl: { value: "", default: "", override: null },
      llmApiKeyHint: null,
      claudeCodeOauthTokenHint: null,
      ...extra,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSourceConfigs).mockResolvedValue({ extractors: [] });
    vi.mocked(getProviderInstances).mockResolvedValue({ providers: [] });
    vi.mocked(listCvDocuments).mockResolvedValue([]);
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile([])],
      defaultProfileId: "p1",
    });
    vi.mocked(getLlmProviderCredentials).mockResolvedValue([]);
    // clearAllMocks keeps implementations, so a rejection set by one test
    // would otherwise leak into the next.
    vi.mocked(saveLlmProviderCredential).mockResolvedValue([]);
    vi.mocked(deleteLlmProviderCredential).mockResolvedValue([]);
    vi.mocked(getCodexAuthStatus).mockResolvedValue({
      authenticated: false,
    } as CodexAuthStatusResponse);
    vi.mocked(validateLlm).mockResolvedValue({
      valid: false,
      message: "No API key",
    });
  });

  async function renderLlmStep(settings: AppSettings) {
    vi.mocked(getSettings).mockResolvedValue(settings);
    const rendered = renderHookWithQueryClient(() => useOnboardingFlow());
    await waitFor(() =>
      expect(rendered.result.current.llmStep.validation.hydrated).toBe(true),
    );
    await waitFor(() => expect(getLlmProviderCredentials).toHaveBeenCalled());
    return rendered;
  }

  /** The app's provider, stored and passing its check. */
  async function renderWithOpenAiInUse(extra: Partial<AppSettings> = {}) {
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    const rendered = await renderLlmStep(
      storedSettings("openai", { llmApiKeyHint: "sk-o", ...extra }),
    );
    await waitFor(() =>
      expect(rendered.result.current.llmStep.validation.valid).toBe(true),
    );
    return rendered;
  }

  it("checks only the saved configuration on mount, sending no key or URL", async () => {
    await renderLlmStep(storedSettings(null));

    expect(validateLlm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(validateLlm).mock.calls[0]).toEqual([
      { provider: "openrouter" },
    ]);
  });

  it("shows nothing configured and offers every provider on a fresh install", async () => {
    const { result } = await renderLlmStep(storedSettings(null));

    expect(result.current.llmStep.configuredProviders).toEqual([]);
    expect(result.current.llmStep.addMakesAppProvider).toBe(true);
    expect(result.current.llmStep.addableProviders).toHaveLength(8);
    expect(result.current.steps[0]?.complete).toBe(false);
    expect(result.current.primaryLabel).toBe("Add a provider to continue");
  });

  it("Test checks the typed key and writes nothing", async () => {
    const { result } = await renderLlmStep(storedSettings(null));
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });

    await act(async () => {
      result.current.llmStep.onSelectProvider("gemini");
    });
    await act(async () => {
      result.current.setValue("llmApiKey", "  AIza-typed  ");
    });
    await act(async () => {
      await result.current.llmStep.onTest();
    });

    expect(vi.mocked(validateLlm).mock.calls.at(-1)).toEqual([
      { provider: "gemini", apiKey: "AIza-typed", baseUrl: undefined },
    ]);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(saveLlmProviderCredential).not.toHaveBeenCalled();
    expect(result.current.llmStep.testResult).toEqual({
      provider: "gemini",
      valid: true,
      message: null,
    });
    // A passing Test is not an Add: nothing is configured, the step is open.
    expect(result.current.llmStep.configuredProviders).toEqual([]);
    expect(result.current.steps[0]?.complete).toBe(false);
  });

  it("Test on a base-URL provider always sends the typed URL, so the stored one is never lent", async () => {
    const { result } = await renderLlmStep(storedSettings(null));

    await act(async () => {
      result.current.llmStep.onSelectProvider("ollama");
    });
    await act(async () => {
      await result.current.llmStep.onTest();
    });

    // An empty string is the server's "explicit override" path (the
    // provider's default URL); undefined would fall back to the stored URL.
    const [input] = vi.mocked(validateLlm).mock.calls.at(-1) ?? [];
    expect(input?.provider).toBe("ollama");
    expect(input?.baseUrl).toBe("");
    expect(input?.apiKey).toBeUndefined();
  });

  it("Test on Claude Code saves the typed token first, then checks", async () => {
    const { result } = await renderLlmStep(storedSettings(null));
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings(null, { claudeCodeOauthTokenHint: "sk-a" }),
    );

    await act(async () => {
      result.current.llmStep.onSelectProvider("claude_code");
    });
    await act(async () => {
      result.current.setValue("claudeCodeOauthToken", "sk-ant-token");
    });
    await act(async () => {
      await result.current.llmStep.onTest();
    });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateSettings).mock.calls[0]).toEqual([
      { claudeCodeOauthToken: "sk-ant-token" },
    ]);
    expect(validateLlm).toHaveBeenCalledWith({
      provider: "claude_code",
      apiKey: undefined,
      baseUrl: undefined,
    });
    // The token save re-checks the app's provider too, so pick out the
    // Claude Code check itself.
    const claudeCheck = vi
      .mocked(validateLlm)
      .mock.calls.findIndex(([input]) => input.provider === "claude_code");
    expect(claudeCheck).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(updateSettings).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(validateLlm).mock.invocationCallOrder[claudeCheck] ?? 0,
    );
  });

  it("Add on a fresh install writes the settings trio without checking the typed key, then checks what was saved", async () => {
    const { result } = await renderLlmStep(storedSettings(null));
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("gemini", { llmApiKeyHint: "AIza" }),
    );
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    vi.mocked(validateLlm).mockClear();

    await act(async () => {
      result.current.llmStep.onSelectProvider("gemini");
    });
    await act(async () => {
      result.current.setValue("llmApiKey", "AIza-typed");
    });
    await act(async () => {
      await result.current.llmStep.onAdd();
    });

    expect(vi.mocked(updateSettings).mock.calls[0]).toEqual([
      {
        llmProvider: "gemini",
        llmBaseUrl: null,
        model: null,
        modelScorer: null,
        modelTailoring: null,
        llmApiKey: "AIza-typed",
      },
    ]);
    expect(saveLlmProviderCredential).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(result.current.llmStep.validation.valid).toBe(true),
    );
    // Only the saved configuration was checked — never the typed key.
    expect(vi.mocked(validateLlm).mock.calls).toEqual([
      [{ provider: "gemini" }],
    ]);
    expect(result.current.llmStep.configuredProviders).toEqual([
      {
        provider: "gemini",
        usedByApp: true,
        details: ["API key AIza********"],
      },
    ]);
    expect(result.current.watch("llmApiKey")).toBe("");
    expect(result.current.steps[0]?.complete).toBe(true);
    expect(result.current.primaryLabel).toBe("Continue");
  });

  it("an app provider added with a bad key shows the failure on its row and leaves the step incomplete", async () => {
    const { result } = await renderLlmStep(storedSettings(null));
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("gemini", { llmApiKeyHint: "bad-" }),
    );
    vi.mocked(validateLlm).mockResolvedValue({
      valid: false,
      message: "Invalid API key",
    });

    await act(async () => {
      result.current.llmStep.onSelectProvider("gemini");
    });
    await act(async () => {
      result.current.setValue("llmApiKey", "bad-key");
    });
    await act(async () => {
      await result.current.llmStep.onAdd();
    });

    await waitFor(() =>
      expect(result.current.llmStep.validation.message).toBe("Invalid API key"),
    );
    expect(result.current.llmStep.configuredProviders).toEqual([
      {
        provider: "gemini",
        usedByApp: true,
        details: ["API key bad-********"],
      },
    ]);
    expect(result.current.steps[0]?.complete).toBe(false);
    expect(result.current.primaryLabel).toBe("Fix the provider to continue");
  });

  it("Add with a provider in use stores a credentials row and leaves the trio alone", async () => {
    const { result } = await renderWithOpenAiInUse();
    vi.mocked(saveLlmProviderCredential).mockResolvedValue([
      { provider: "gemini", apiKeyHint: "AIza", baseUrl: null },
    ]);
    vi.mocked(validateLlm).mockClear();

    await act(async () => {
      result.current.llmStep.onSelectProvider("gemini");
    });
    await act(async () => {
      result.current.setValue("llmApiKey", "AIza-typed");
    });
    await act(async () => {
      await result.current.llmStep.onAdd();
    });

    expect(vi.mocked(saveLlmProviderCredential).mock.calls[0]).toEqual([
      "gemini",
      { apiKey: "AIza-typed" },
    ]);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(validateLlm).not.toHaveBeenCalled();
    expect(result.current.llmStep.configuredProviders).toEqual([
      {
        provider: "openai",
        usedByApp: true,
        details: ["API key sk-o********"],
      },
      {
        provider: "gemini",
        usedByApp: false,
        details: ["API key AIza********"],
      },
    ]);
    expect(result.current.llmStep.addableProviders).not.toContain("gemini");
    expect(result.current.llmStep.addableProviders).not.toContain("openai");
  });

  it("an extra base-URL provider needs a URL before Add, so no empty row is stored", async () => {
    const { result } = await renderWithOpenAiInUse();

    await act(async () => {
      result.current.llmStep.onSelectProvider("ollama");
    });
    expect(result.current.llmStep.addDisabledReason).not.toBeNull();
    await act(async () => {
      await result.current.llmStep.onAdd();
    });
    expect(saveLlmProviderCredential).not.toHaveBeenCalled();

    await act(async () => {
      result.current.setValue("llmBaseUrl", "http://ollama:11434");
    });
    expect(result.current.llmStep.addDisabledReason).toBeNull();
  });

  it("disables Test and Add for a key provider until a key is typed, and changing the dropdown checks nothing", async () => {
    const { result } = await renderWithOpenAiInUse();
    vi.mocked(validateLlm).mockClear();

    await act(async () => {
      result.current.llmStep.onSelectProvider("gemini");
    });
    await act(async () => {
      result.current.setValue("llmApiKey", "AIza-typed");
    });
    expect(result.current.llmStep.canTest).toBe(true);
    // A key typed for one provider is cleared when another is picked, so it
    // can never be tested against, or saved for, the wrong vendor.
    await act(async () => {
      result.current.llmStep.onSelectProvider("openrouter");
    });

    // B99's client half: picking a provider used to re-run the check with
    // the stored key, sending it to the newly picked vendor.
    expect(validateLlm).not.toHaveBeenCalled();
    expect(result.current.llmStep.addProvider).toBe("openrouter");
    expect(result.current.llmStep.canTest).toBe(false);
    expect(result.current.llmStep.addDisabledReason).not.toBeNull();
    await act(async () => {
      await result.current.llmStep.onTest();
    });
    expect(validateLlm).not.toHaveBeenCalled();
  });

  it("Remove on an extra deletes its credentials row only", async () => {
    vi.mocked(getLlmProviderCredentials).mockResolvedValue([
      { provider: "gemini", apiKeyHint: "AIza", baseUrl: null },
    ]);
    const { result } = await renderWithOpenAiInUse();
    await waitFor(() =>
      expect(result.current.llmStep.configuredProviders).toHaveLength(2),
    );
    vi.mocked(deleteLlmProviderCredential).mockResolvedValue([]);

    await act(async () => {
      await result.current.llmStep.onRemove("gemini");
    });

    expect(deleteLlmProviderCredential).toHaveBeenCalledWith("gemini");
    expect(updateSettings).not.toHaveBeenCalled();
    expect(
      result.current.llmStep.configuredProviders.map((row) => row.provider),
    ).toEqual(["openai"]);
  });

  it("Remove on the app's provider clears the trio, reopens the step and leaves the extras alone", async () => {
    vi.mocked(getLlmProviderCredentials).mockResolvedValue([
      { provider: "gemini", apiKeyHint: "AIza", baseUrl: null },
    ]);
    const { result } = await renderWithOpenAiInUse();
    await waitFor(() =>
      expect(result.current.llmStep.configuredProviders).toHaveLength(2),
    );
    vi.mocked(updateSettings).mockResolvedValue(storedSettings(null));
    vi.mocked(deleteLlmProviderCredential).mockResolvedValue([
      { provider: "gemini", apiKeyHint: "AIza", baseUrl: null },
    ]);
    vi.mocked(validateLlm).mockResolvedValue({
      valid: false,
      message: "No API key",
    });

    await act(async () => {
      await result.current.llmStep.onRemove("openai");
    });

    expect(vi.mocked(updateSettings).mock.calls).toEqual([
      [{ llmProvider: null, llmApiKey: null, llmBaseUrl: null }],
    ]);
    // Its own (here absent) row only; never another provider's.
    expect(vi.mocked(deleteLlmProviderCredential).mock.calls).toEqual([
      ["openai"],
    ]);
    expect(toast.success).toHaveBeenCalledWith("OpenAI removed");
    expect(toast.info).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(result.current.llmStep.validation.valid).toBe(false),
    );
    expect(result.current.steps[0]?.complete).toBe(false);
    expect(result.current.llmStep.configuredProviders).toEqual([
      {
        provider: "gemini",
        usedByApp: false,
        details: ["API key AIza********"],
      },
    ]);
    expect(result.current.llmStep.addMakesAppProvider).toBe(true);
  });

  it("Remove on the app's provider also deletes its own credentials row, which it was shown merged with", async () => {
    vi.mocked(getLlmProviderCredentials).mockResolvedValue([
      { provider: "openai", apiKeyHint: "sk-x", baseUrl: null },
    ]);
    const { result } = await renderWithOpenAiInUse();
    await waitFor(() => expect(getLlmProviderCredentials).toHaveBeenCalled());
    expect(result.current.llmStep.configuredProviders).toEqual([
      {
        provider: "openai",
        usedByApp: true,
        details: ["API key sk-o********"],
      },
    ]);
    vi.mocked(updateSettings).mockResolvedValue(storedSettings(null));
    vi.mocked(deleteLlmProviderCredential).mockResolvedValue([]);
    vi.mocked(validateLlm).mockResolvedValue({
      valid: false,
      message: "No API key",
    });

    await act(async () => {
      await result.current.llmStep.onRemove("openai");
    });

    expect(deleteLlmProviderCredential).toHaveBeenCalledWith("openai");
    await waitFor(() =>
      expect(result.current.llmStep.configuredProviders).toEqual([]),
    );
  });

  it("Remove on Claude Code as the app's provider also clears its token", async () => {
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    const { result } = await renderLlmStep(
      storedSettings("claude_code", { claudeCodeOauthTokenHint: "sk-a" }),
    );
    vi.mocked(updateSettings).mockResolvedValue(storedSettings(null));

    await act(async () => {
      await result.current.llmStep.onRemove("claude_code");
    });

    expect(vi.mocked(updateSettings).mock.calls).toEqual([
      [
        {
          llmProvider: null,
          llmApiKey: null,
          llmBaseUrl: null,
          claudeCodeOauthToken: null,
        },
      ],
    ]);
  });

  it("lists a saved Claude Code token and a Codex sign-in as providers, and Remove clears each", async () => {
    vi.mocked(getCodexAuthStatus).mockResolvedValue({
      authenticated: true,
    } as CodexAuthStatusResponse);
    const { result } = await renderWithOpenAiInUse({
      claudeCodeOauthTokenHint: "sk-a",
    });
    await waitFor(() =>
      expect(result.current.llmStep.configuredProviders).toHaveLength(3),
    );
    expect(result.current.llmStep.configuredProviders).toEqual([
      {
        provider: "openai",
        usedByApp: true,
        details: ["API key sk-o********"],
      },
      { provider: "codex", usedByApp: false, details: ["Signed in"] },
      { provider: "claude_code", usedByApp: false, details: ["Token saved"] },
    ]);
    expect(result.current.llmStep.addableProviders).not.toContain("codex");
    expect(result.current.llmStep.addableProviders).not.toContain(
      "claude_code",
    );

    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("openai", { llmApiKeyHint: "sk-o" }),
    );
    vi.mocked(disconnectCodexAuth).mockResolvedValue({
      authenticated: false,
    } as CodexAuthStatusResponse);
    await act(async () => {
      await result.current.llmStep.onRemove("claude_code");
    });
    expect(vi.mocked(updateSettings).mock.calls).toEqual([
      [{ claudeCodeOauthToken: null }],
    ]);
    await act(async () => {
      await result.current.llmStep.onRemove("codex");
    });
    expect(disconnectCodexAuth).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        result.current.llmStep.configuredProviders.map((row) => row.provider),
      ).toEqual(["openai"]),
    );
  });

  it("adds Claude Code as an extra by saving its token", async () => {
    const { result } = await renderWithOpenAiInUse();
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("openai", {
        llmApiKeyHint: "sk-o",
        claudeCodeOauthTokenHint: "sk-a",
      }),
    );

    await act(async () => {
      result.current.llmStep.onSelectProvider("claude_code");
    });
    expect(result.current.llmStep.addDisabledReason).not.toBeNull();
    await act(async () => {
      result.current.setValue("claudeCodeOauthToken", "sk-ant-token");
    });
    await act(async () => {
      await result.current.llmStep.onAdd();
    });

    expect(vi.mocked(updateSettings).mock.calls).toEqual([
      [{ claudeCodeOauthToken: "sk-ant-token" }],
    ]);
    expect(saveLlmProviderCredential).not.toHaveBeenCalled();
  });

  it("shows a stored provider with nothing else saved as the app's, failing check and all", async () => {
    // Codex not signed in: the stored choice is the only thing saved, and the
    // row is how the user sees the failure and can remove it.
    const { result } = await renderLlmStep(storedSettings("codex"));

    expect(result.current.llmStep.configuredProviders).toEqual([
      { provider: "codex", usedByApp: true, details: [] },
    ]);
    expect(result.current.llmStep.addMakesAppProvider).toBe(false);
    expect(result.current.primaryLabel).toBe("Fix the provider to continue");
  });

  it("Tests Ollama next to another provider sending only its own URL (the server lends no stored key)", async () => {
    const { result } = await renderWithOpenAiInUse();
    vi.mocked(validateLlm).mockClear();

    await act(async () => {
      result.current.llmStep.onSelectProvider("ollama");
    });
    expect(result.current.llmStep.canTest).toBe(true);
    await act(async () => {
      await result.current.llmStep.onTest();
    });

    const [input] = vi.mocked(validateLlm).mock.calls.at(-1) ?? [];
    expect(input?.provider).toBe("ollama");
    expect(input?.baseUrl).toBe("");
    expect(input?.apiKey).toBeUndefined();
  });

  it("making a keyless provider the app's clears the stored key and replaces its own credentials row", async () => {
    vi.mocked(getLlmProviderCredentials).mockResolvedValue([
      { provider: "ollama", apiKeyHint: null, baseUrl: "http://old:11434" },
    ]);
    const { result } = await renderLlmStep(storedSettings(null));
    await waitFor(() =>
      expect(result.current.llmStep.configuredProviders).toHaveLength(1),
    );
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("ollama", {
        llmBaseUrl: {
          value: "http://new:11434",
          default: "",
          override: "http://new:11434",
        },
      }),
    );
    vi.mocked(deleteLlmProviderCredential).mockResolvedValue([]);

    await act(async () => {
      result.current.llmStep.onSelectProvider("ollama");
    });
    await act(async () => {
      result.current.setValue("llmBaseUrl", "http://new:11434");
    });
    await act(async () => {
      await result.current.llmStep.onAdd();
    });

    expect(vi.mocked(updateSettings).mock.calls[0]?.[0]).toEqual({
      llmProvider: "ollama",
      llmBaseUrl: "http://new:11434",
      llmApiKey: null,
      model: null,
      modelScorer: null,
      modelTailoring: null,
    });
    expect(vi.mocked(updateSettings).mock.calls[0]?.[0]).toHaveProperty(
      "llmApiKey",
      null,
    );
    expect(deleteLlmProviderCredential).toHaveBeenCalledWith("ollama");
  });

  it("needs a base URL for OpenAI-compatible even as the app's provider", async () => {
    const { result } = await renderLlmStep(storedSettings(null));

    await act(async () => {
      result.current.llmStep.onSelectProvider("openai_compatible");
    });
    await act(async () => {
      result.current.setValue("llmApiKey", "token");
    });
    expect(result.current.llmStep.addDisabledReason).not.toBeNull();

    await act(async () => {
      result.current.setValue("llmBaseUrl", "https://proxy.example.test/v1");
    });
    expect(result.current.llmStep.addDisabledReason).toBeNull();
  });

  it("clears a typed key when the picked provider changes on its own", async () => {
    // Untouched dropdown on a fresh install: the box shows the default
    // provider. Once that provider is in use it leaves the list, the box moves
    // on, and the key typed for the first must not follow it.
    const { result, queryClient } = await renderLlmStep(storedSettings(null));
    expect(result.current.llmStep.addProvider).toBe("openrouter");
    await act(async () => {
      result.current.setValue("llmApiKey", "sk-or-typed");
    });

    await act(async () => {
      queryClient.setQueryData(
        ["settings", "current"],
        storedSettings("openrouter", { llmApiKeyHint: "sk-o" }),
      );
    });

    await waitFor(() =>
      expect(result.current.llmStep.addProvider).not.toBe("openrouter"),
    );
    expect(result.current.watch("llmApiKey")).toBe("");
  });

  it("re-checks the app's provider when Codex signs in", async () => {
    // The environment names Codex and nothing is stored: signing in changes
    // no setting, so only the sign-in itself can trigger the re-check.
    const { result } = await renderLlmStep(
      createAppSettings({
        llmProvider: { value: "codex", default: "codex", override: null },
        llmBaseUrl: { value: "", default: "", override: null },
        llmApiKeyHint: null,
        claudeCodeOauthTokenHint: null,
      }),
    );
    expect(result.current.llmStep.validation.valid).toBe(false);
    expect(result.current.llmStep.configuredProviders).toEqual([]);
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    vi.mocked(validateLlm).mockClear();

    await act(async () => {
      result.current.llmStep.onCodexStatusChange({
        authenticated: true,
      } as CodexAuthStatusResponse);
    });

    await waitFor(() =>
      expect(result.current.llmStep.validation.valid).toBe(true),
    );
    expect(vi.mocked(validateLlm).mock.calls).toEqual([
      [{ provider: "codex" }],
    ]);
    expect(result.current.steps[0]?.complete).toBe(true);
  });

  it("a check that lands late for the previous provider does not count for the new one", async () => {
    let resolveOld: (value: {
      valid: boolean;
      message: string | null;
    }) => void = () => {};
    vi.mocked(validateLlm).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    vi.mocked(getSettings).mockResolvedValue(
      storedSettings("openai", { llmApiKeyHint: "sk-o" }),
    );
    const { result, queryClient } = renderHookWithQueryClient(() =>
      useOnboardingFlow(),
    );
    await waitFor(() => expect(validateLlm).toHaveBeenCalledTimes(1));

    // The stored provider changes while the openai check is still running.
    vi.mocked(validateLlm).mockResolvedValue({
      valid: false,
      message: "No API key",
    });
    await act(async () => {
      queryClient.setQueryData(["settings", "current"], storedSettings(null));
    });
    await waitFor(() =>
      expect(validateLlm).toHaveBeenLastCalledWith({ provider: "openrouter" }),
    );
    await waitFor(() =>
      expect(result.current.llmStep.validation.hydrated).toBe(true),
    );

    await act(async () => {
      resolveOld({ valid: true, message: null });
    });

    expect(result.current.llmStep.validation.valid).toBe(false);
    expect(result.current.steps[0]?.complete).toBe(false);
    expect(result.current.llmStep.configuredProviders).toEqual([]);
  });

  it("makes Claude Code the app's provider with its typed token, and needs one when none is saved", async () => {
    const { result } = await renderLlmStep(storedSettings(null));
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("claude_code", { claudeCodeOauthTokenHint: "sk-a" }),
    );

    await act(async () => {
      result.current.llmStep.onSelectProvider("claude_code");
    });
    // Without a token its check cannot pass: the CLI has no other login.
    expect(result.current.llmStep.addDisabledReason).not.toBeNull();
    await act(async () => {
      result.current.setValue("claudeCodeOauthToken", "sk-ant-token");
    });
    await act(async () => {
      await result.current.llmStep.onAdd();
    });

    expect(vi.mocked(updateSettings).mock.calls[0]?.[0]).toEqual({
      llmProvider: "claude_code",
      llmBaseUrl: null,
      llmApiKey: null,
      claudeCodeOauthToken: "sk-ant-token",
      model: null,
      modelScorer: null,
      modelTailoring: null,
    });
  });

  it("needs a base URL to Test OpenAI-compatible, so the token is never checked against OpenAI", async () => {
    const { result } = await renderLlmStep(storedSettings(null));

    await act(async () => {
      result.current.llmStep.onSelectProvider("openai_compatible");
    });
    await act(async () => {
      result.current.setValue("llmApiKey", "token");
    });
    expect(result.current.llmStep.canTest).toBe(false);

    await act(async () => {
      result.current.setValue("llmBaseUrl", "https://proxy.example.test/v1");
    });
    expect(result.current.llmStep.canTest).toBe(true);
  });

  it("says so, instead of claiming success, when Remove cannot clear what the server's environment sets", async () => {
    const { result } = await renderWithOpenAiInUse();
    // The nulls restore the environment's values, so nothing changes.
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("openai", {
        llmProvider: { value: "openai", default: "openai", override: null },
        llmApiKeyHint: "sk-e",
      }),
    );

    await act(async () => {
      await result.current.llmStep.onRemove("openai");
    });

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      "OpenAI is set by the server's environment, so it cannot be removed here.",
    );
  });

  it("still reports the provider as added when only the old credentials row fails to delete", async () => {
    vi.mocked(getLlmProviderCredentials).mockResolvedValue([
      { provider: "gemini", apiKeyHint: "old-", baseUrl: null },
    ]);
    const { result } = await renderLlmStep(storedSettings(null));
    await waitFor(() =>
      expect(result.current.llmStep.configuredProviders).toHaveLength(1),
    );
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("gemini", { llmApiKeyHint: "AIza" }),
    );
    vi.mocked(deleteLlmProviderCredential).mockRejectedValue(
      new Error("database is locked"),
    );

    await act(async () => {
      result.current.llmStep.onSelectProvider("gemini");
    });
    await act(async () => {
      result.current.setValue("llmApiKey", "AIza-typed");
    });
    await act(async () => {
      await result.current.llmStep.onAdd();
    });

    expect(toast.error).toHaveBeenCalledWith(
      "Gemini was added, but its older saved credential could not be removed: database is locked",
    );
    expect(toast.success).toHaveBeenCalledWith(
      "Gemini added — the app runs on it",
      expect.anything(),
    );
    expect(result.current.watch("llmApiKey")).toBe("");
  });

  it("stays busy until the saved credentials are loaded, so nothing acts on a list that is not there yet", async () => {
    vi.mocked(getLlmProviderCredentials).mockReturnValue(new Promise(() => {}));
    vi.mocked(getSettings).mockResolvedValue(storedSettings(null));
    const { result } = renderHookWithQueryClient(() => useOnboardingFlow());

    await waitFor(() =>
      expect(result.current.llmStep.validation.hydrated).toBe(true),
    );
    expect(result.current.isBusy).toBe(true);
  });

  it("reports a Remove as done when the provider the server falls back to is a different one", async () => {
    const { result } = await renderWithOpenAiInUse();
    // The environment supplies a key, but for its own default provider.
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings(null, { llmApiKeyHint: "sk-e" }),
    );
    vi.mocked(validateLlm).mockResolvedValue({
      valid: false,
      message: "Invalid API key",
    });

    await act(async () => {
      await result.current.llmStep.onRemove("openai");
    });

    expect(toast.success).toHaveBeenCalledWith("OpenAI removed");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("says Claude Code stays listed when its token comes from the environment, after it stops running the app", async () => {
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    const { result } = await renderLlmStep(
      storedSettings("claude_code", { claudeCodeOauthTokenHint: "sk-a" }),
    );
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings(null, { claudeCodeOauthTokenHint: "sk-e" }),
    );

    await act(async () => {
      await result.current.llmStep.onRemove("claude_code");
    });

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith(
      "Claude Code no longer runs the app, but its token comes from the server's environment, so it stays listed.",
    );
  });

  it("says an environment Claude Code token cannot be removed from the extras", async () => {
    const { result } = await renderWithOpenAiInUse({
      claudeCodeOauthTokenHint: "sk-e",
    });
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("openai", {
        llmApiKeyHint: "sk-o",
        claudeCodeOauthTokenHint: "sk-e",
      }),
    );

    await act(async () => {
      await result.current.llmStep.onRemove("claude_code");
    });

    expect(toast.info).toHaveBeenCalledWith(
      "Claude Code is set by the server's environment, so it cannot be removed here.",
    );
  });

  it("deletes the provider's own credentials row on Add even when the credentials failed to load", async () => {
    vi.mocked(getLlmProviderCredentials).mockRejectedValue(
      new Error("offline"),
    );
    vi.mocked(getSettings).mockResolvedValue(storedSettings(null));
    const { result } = renderHookWithQueryClient(() => useOnboardingFlow());
    await waitFor(() =>
      expect(result.current.llmStep.validation.hydrated).toBe(true),
    );
    await waitFor(() => expect(result.current.isBusy).toBe(false));
    vi.mocked(updateSettings).mockResolvedValue(
      storedSettings("gemini", { llmApiKeyHint: "AIza" }),
    );
    vi.mocked(deleteLlmProviderCredential).mockResolvedValue([]);

    await act(async () => {
      result.current.llmStep.onSelectProvider("gemini");
    });
    await act(async () => {
      result.current.setValue("llmApiKey", "AIza-typed");
    });
    await act(async () => {
      await result.current.llmStep.onAdd();
    });

    expect(deleteLlmProviderCredential).toHaveBeenCalledWith("gemini");
  });

  it("checks a signed-in Codex once on load, not again when its status first arrives", async () => {
    let resolveStatus: (value: CodexAuthStatusResponse) => void = () => {};
    vi.mocked(getCodexAuthStatus).mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    vi.mocked(getSettings).mockResolvedValue(storedSettings("codex"));
    const { result } = renderHookWithQueryClient(() => useOnboardingFlow());
    await waitFor(() =>
      expect(result.current.llmStep.validation.valid).toBe(true),
    );

    await act(async () => {
      resolveStatus({ authenticated: true } as CodexAuthStatusResponse);
    });
    await waitFor(() =>
      expect(result.current.llmStep.codexSignedIn).toBe(true),
    );

    expect(validateLlm).toHaveBeenCalledTimes(1);
  });

  it("deletes the app's provider's own credentials row on Remove even when the credentials failed to load", async () => {
    vi.mocked(getLlmProviderCredentials).mockRejectedValue(
      new Error("offline"),
    );
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    vi.mocked(getSettings).mockResolvedValue(
      storedSettings("openai", { llmApiKeyHint: "sk-o" }),
    );
    const { result } = renderHookWithQueryClient(() => useOnboardingFlow());
    await waitFor(() =>
      expect(result.current.llmStep.validation.valid).toBe(true),
    );
    await waitFor(() => expect(result.current.isBusy).toBe(false));
    vi.mocked(updateSettings).mockResolvedValue(storedSettings(null));
    vi.mocked(deleteLlmProviderCredential).mockResolvedValue([]);

    await act(async () => {
      await result.current.llmStep.onRemove("openai");
    });

    expect(deleteLlmProviderCredential).toHaveBeenCalledWith("openai");
  });

  it("re-checks when Codex signs out while a check of it is already running", async () => {
    vi.mocked(getCodexAuthStatus).mockResolvedValue({
      authenticated: true,
    } as CodexAuthStatusResponse);
    const codexFromEnvironment = createAppSettings({
      llmProvider: { value: "codex", default: "codex", override: null },
      llmBaseUrl: { value: "", default: "", override: null },
      llmApiKeyHint: null,
      claudeCodeOauthTokenHint: null,
    });
    vi.mocked(getSettings).mockResolvedValue(codexFromEnvironment);
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    const { result, queryClient } = renderHookWithQueryClient(() =>
      useOnboardingFlow(),
    );
    await waitFor(() =>
      expect(result.current.llmStep.codexSignedIn).toBe(true),
    );
    await waitFor(() =>
      expect(result.current.llmStep.validation.valid).toBe(true),
    );

    const pending: Array<
      (value: { valid: boolean; message: string | null }) => void
    > = [];
    vi.mocked(validateLlm).mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    // A settings write starts a check, which reads the sign-in before the
    // sign-out below lands.
    await act(async () => {
      queryClient.setQueryData(["settings", "current"], {
        ...codexFromEnvironment,
        candidateName: { value: "Jo", default: null, override: "Jo" },
      });
    });
    await waitFor(() => expect(pending).toHaveLength(1));

    await act(async () => {
      result.current.llmStep.onCodexStatusChange({
        authenticated: false,
      } as CodexAuthStatusResponse);
    });
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => {
      pending[0]?.({ valid: true, message: null });
    });
    await act(async () => {
      pending[1]?.({ valid: false, message: "Not signed in" });
    });

    expect(result.current.llmStep.validation.message).toBe("Not signed in");
    expect(result.current.steps[0]?.complete).toBe(false);
  });

  it("does not say it is checking while nothing has been added", async () => {
    vi.mocked(validateLlm).mockReturnValue(new Promise(() => {}));
    vi.mocked(getSettings).mockResolvedValue(storedSettings(null));
    const { result } = renderHookWithQueryClient(() => useOnboardingFlow());

    await waitFor(() => expect(validateLlm).toHaveBeenCalled());
    expect(result.current.primaryLabel).toBe("Add a provider to continue");
  });

  it("labels the footer as checking while the app's provider is being checked", async () => {
    vi.mocked(validateLlm).mockReturnValue(new Promise(() => {}));
    vi.mocked(getSettings).mockResolvedValue(
      storedSettings("openai", { llmApiKeyHint: "sk-o" }),
    );
    const { result } = renderHookWithQueryClient(() => useOnboardingFlow());

    await waitFor(() => expect(validateLlm).toHaveBeenCalled());
    await waitFor(() =>
      expect(result.current.primaryLabel).toBe("Checking the provider…"),
    );
  });

  it("an older check finishing first neither ends the busy state nor writes its result", async () => {
    const pending: Array<
      (value: { valid: boolean; message: string | null }) => void
    > = [];
    vi.mocked(validateLlm).mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    vi.mocked(getSettings).mockResolvedValue(
      storedSettings("openai", { llmApiKeyHint: "sk-o" }),
    );
    const { result, queryClient } = renderHookWithQueryClient(() =>
      useOnboardingFlow(),
    );
    await waitFor(() => expect(pending).toHaveLength(1));

    // Same provider, new key: the provider stamp cannot tell the two checks
    // apart, only the request counter can.
    await act(async () => {
      queryClient.setQueryData(
        ["settings", "current"],
        storedSettings("openai", { llmApiKeyHint: "sk-n" }),
      );
    });
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => {
      pending[0]?.({ valid: true, message: null });
    });
    expect(result.current.llmStep.isValidating).toBe(true);
    expect(result.current.llmStep.validation.hydrated).toBe(false);

    await act(async () => {
      pending[1]?.({ valid: false, message: "No API key" });
    });
    expect(result.current.llmStep.isValidating).toBe(false);
    expect(result.current.llmStep.validation.message).toBe("No API key");
  });

  it("offers a provider already configured as an extra while none is in use", async () => {
    // Otherwise a fresh install whose environment supplies a Claude Code token
    // could never make Claude Code the app's provider.
    const { result } = await renderLlmStep(
      storedSettings(null, { claudeCodeOauthTokenHint: "sk-a" }),
    );

    expect(result.current.llmStep.configuredProviders).toEqual([
      { provider: "claude_code", usedByApp: false, details: ["Token saved"] },
    ]);
    expect(result.current.llmStep.addableProviders).toContain("claude_code");
  });

  it("the footer stays on the step with a toast until the app's provider passes its check", async () => {
    const { result } = await renderLlmStep(storedSettings(null));

    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(result.current.currentStep).toBe("llm");
    expect(toast.info).toHaveBeenCalledWith("Add a provider to continue");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("Continue moves to the next step once the app's provider passes its check", async () => {
    const { result } = await renderWithOpenAiInUse();

    await act(async () => {
      await result.current.handlePrimaryAction();
    });

    expect(result.current.currentStep).toBe("cvformat");
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

describe("useOnboardingFlow — saving the CV format", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockResolvedValue(createAppSettings());
    vi.mocked(getSourceConfigs).mockResolvedValue({ extractors: [] });
    vi.mocked(getProviderInstances).mockResolvedValue({ providers: [] });
    vi.mocked(validateLlm).mockResolvedValue({ valid: true, message: null });
    vi.mocked(listCvDocuments).mockResolvedValue([]);
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile([])],
      defaultProfileId: "p1",
    });
  });

  it("names the saved format, whichever it is", async () => {
    for (const [format, name] of [
      ["docx", "Word"],
      ["html", "HTML"],
    ] as const) {
      vi.mocked(updateSettings).mockResolvedValue(
        createAppSettings({ cvSourceFormat: format }),
      );
      const { result, unmount } = renderHookWithQueryClient(() =>
        useOnboardingFlow(),
      );
      await waitFor(() => expect(result.current.settings).not.toBeNull());
      await act(async () => {
        result.current.setCurrentStep("cvformat");
        result.current.setCvFormatChoice(format);
      });
      await act(async () => {
        await result.current.handlePrimaryAction();
      });
      expect(updateSettings).toHaveBeenCalledWith({ cvSourceFormat: format });
      expect(toast.success).toHaveBeenCalledWith(`CV format set to ${name}`);
      unmount();
    }
  });
});
