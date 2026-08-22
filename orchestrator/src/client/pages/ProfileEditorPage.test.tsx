import type { SourceConfigsExtractorEntry } from "@client/api";
import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import type { Profile } from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  getProfiles: vi.fn(),
  getSourceConfigs: vi.fn(),
  getProviderInstances: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  // Consumed by PageHeader's nav-drawer profile line.
  getActiveUserProfile: vi.fn().mockResolvedValue({ name: "Default" }),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import {
  createProfile,
  getProfiles,
  getProviderInstances,
  getSourceConfigs,
  updateProfile,
} from "@client/api";
import { ProfileEditorPage } from "./ProfileEditorPage";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    name: "Remote ML",
    config: {
      searchTerms: ["ml engineer"],
      searchCountry: "Germany",
      searchCities: "Berlin|Munich",
      workplaceTypes: ["remote"],
      locationSearchScope: "selected_only",
      locationMatchStrictness: "exact_only",
      remoteProfile: false,
      remoteLocationBlocklist: [],
      scrapeMaxAgeDays: null,
      scrapeSinceLastRun: false,
      blockedCompanyKeywords: [],
      runBudget: 500,
      topN: 10,
      minSuitabilityCategory: "good_fit",
      enabledSourceIds: ["jobspy"],
      providerInstanceIds: [],
    },
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeExtractor(
  extractorId: string,
  displayName: string,
  enabled = true,
): SourceConfigsExtractorEntry {
  return {
    extractorId,
    displayName,
    providesSources: [],
    row: {
      extractorId,
      enabled,
      config: {},
      mappings: {},
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    schema: null,
    effectiveSettings: {},
  };
}

function renderAt(path: string) {
  return renderWithQueryClient(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/profiles" element={<div>profiles-list</div>} />
        <Route path="/profiles/new" element={<ProfileEditorPage />} />
        <Route path="/profiles/:id" element={<ProfileEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProfileEditorPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [makeProfile({ id: "p1", name: "Remote ML" })],
      defaultProfileId: "p1",
    });
    vi.mocked(getSourceConfigs).mockResolvedValue({
      extractors: [
        makeExtractor("jobspy", "JobSpy"),
        makeExtractor("hiringcafe", "Hiring Cafe"),
      ],
    });
    vi.mocked(getProviderInstances).mockResolvedValue({ providers: [] });
    vi.mocked(updateProfile).mockResolvedValue(makeProfile({ id: "p1" }));
    vi.mocked(createProfile).mockResolvedValue(makeProfile({ id: "p9" }));
  });

  it("hydrates an existing profile's values in edit mode", async () => {
    renderAt("/profiles/p1");
    expect(await screen.findByLabelText("Name")).toHaveValue("Remote ML");
    expect(screen.getByLabelText("Max jobs discovered")).toHaveValue(500);
  });

  it("hides the geography fields on a remote profile and restores them on untick", async () => {
    renderAt("/profiles/p1");
    expect(await screen.findByLabelText("Name")).toHaveValue("Remote ML");
    expect(screen.getByText("Country")).toBeInTheDocument();
    expect(screen.getByLabelText("Cities")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Remote profile"));
    expect(screen.queryByText("Country")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Cities")).not.toBeInTheDocument();
    expect(screen.queryByText("Location scope")).not.toBeInTheDocument();
    expect(screen.queryByText("Work arrangement")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Exclude locations")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Remote profile"));
    // The stored country survives the round-trip untouched.
    expect(screen.getByLabelText("Germany")).toBeInTheDocument();
    expect(screen.getByLabelText("Cities")).toBeInTheDocument();
    expect(screen.getByText("Work arrangement")).toBeInTheDocument();
    // The stored ticks survive the hide too.
    expect(screen.getByLabelText("Remote")).toBeChecked();
  });

  it("saves edits via updateProfile and returns to the list", async () => {
    renderAt("/profiles/p1");
    const nameInput = await screen.findByLabelText("Name");
    fireEvent.change(nameInput, { target: { value: "Renamed" } });

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        name: "Renamed",
        config: expect.objectContaining({
          searchTerms: ["ml engineer"],
          runBudget: 500,
        }),
      }),
    );
    expect(await screen.findByText("profiles-list")).toBeInTheDocument();
  });

  it("pins an extractor and includes it in the saved config", async () => {
    renderAt("/profiles/p1");
    await screen.findByLabelText("Name");

    fireEvent.click(await screen.findByLabelText("Hiring Cafe"));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    const [, patch] = vi.mocked(updateProfile).mock.calls[0];
    expect(patch.config?.enabledSourceIds).toEqual(
      expect.arrayContaining(["jobspy", "hiringcafe"]),
    );
  });

  it("creates a new profile pre-ticked with every enabled source", async () => {
    renderAt("/profiles/new");
    const nameInput = await screen.findByLabelText("Name");
    const save = screen.getByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: "Fresh" } });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => expect(createProfile).toHaveBeenCalledTimes(1));
    const [input] = vi.mocked(createProfile).mock.calls[0];
    expect(input.name).toBe("Fresh");
    // Pins the new invariant: a fresh profile is born with its sources ticked,
    // not empty. An empty list now means "no sources", so a regression here
    // would ship a profile that scrapes nothing.
    expect(input.config?.enabledSourceIds).toEqual(
      expect.arrayContaining(["jobspy", "hiringcafe"]),
    );
    expect(await screen.findByText("profiles-list")).toBeInTheDocument();
  });

  it("greys out a source disabled on the Sources page", async () => {
    vi.mocked(getSourceConfigs).mockResolvedValue({
      extractors: [
        makeExtractor("jobspy", "JobSpy"),
        makeExtractor("hiringcafe", "Hiring Cafe", false),
      ],
    });

    renderAt("/profiles/p1");
    await screen.findByLabelText("Name");

    // Visible, never hidden — the user has to see why they cannot pick it.
    expect(await screen.findByLabelText("Hiring Cafe")).toBeDisabled();
    expect(screen.getByLabelText("JobSpy")).toBeEnabled();
    expect(
      screen.getByText(/disabled on the Sources page/i),
    ).toBeInTheDocument();
  });

  it("blocks save when every ticked source is disabled", async () => {
    // Ticked in the profile, but disabled on the Sources page → it cannot run.
    // A ticks-only guard would call this valid and then launch runs that
    // silently scrape nothing.
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [
        makeProfile({
          id: "p1",
          config: {
            ...makeProfile().config,
            enabledSourceIds: ["hiringcafe"],
            providerInstanceIds: [],
          },
        }),
      ],
      defaultProfileId: "p1",
    });
    vi.mocked(getSourceConfigs).mockResolvedValue({
      extractors: [
        makeExtractor("jobspy", "JobSpy"),
        makeExtractor("hiringcafe", "Hiring Cafe", false),
      ],
    });

    renderAt("/profiles/p1");
    await screen.findByLabelText("Name");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled(),
    );
    expect(screen.getByText(/Select at least one source/i)).toBeInTheDocument();

    // Ticking an enabled source makes the selection effective again.
    fireEvent.click(screen.getByLabelText("JobSpy"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled(),
    );
  });
});
