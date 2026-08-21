import type { SourceConfigsExtractorEntry } from "@client/api";
import { renderHookWithQueryClient } from "@client/test/renderWithQueryClient";
import { createAppSettings } from "@shared/testing/factories";
import type { CvDocument, Profile, ProviderInstanceRow } from "@shared/types";
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
}));

vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  getCvDocument,
  getProfiles,
  getProviderInstances,
  getSettings,
  getSourceConfigs,
  listCvDocuments,
  suggestOnboardingSearchTerms,
  updateProfile,
  updateProviderInstance,
  validateLlm,
} from "@client/api";
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
      scrapeMaxAgeDays: null,
      scrapeSinceLastRun: false,
      blockedCompanyKeywords: [],
      runBudget: 500,
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
