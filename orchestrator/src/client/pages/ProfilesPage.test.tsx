import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import type { Profile } from "@shared/types";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  getProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
  setDefaultProfile: vi.fn(),
  duplicateProfile: vi.fn(),
  // Consumed by PageHeader's nav-drawer profile line.
  getActiveUserProfile: vi.fn().mockResolvedValue({ name: "Default" }),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import {
  deleteProfile,
  duplicateProfile,
  getProfiles,
  setDefaultProfile,
} from "@client/api";
import { toast } from "@client/lib/toast";
import { ProfilesPage } from "./ProfilesPage";

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

const profileA = makeProfile({ id: "p1", name: "Remote ML" });
const profileB = makeProfile({ id: "p2", name: "Berlin backend" });

function renderPage() {
  return renderWithQueryClient(
    <MemoryRouter initialEntries={["/profiles"]}>
      <Routes>
        <Route path="/profiles" element={<ProfilesPage />} />
        <Route path="/profiles/new" element={<div>editor-new</div>} />
        <Route path="/profiles/:id" element={<div>editor-edit</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProfilesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [profileA, profileB],
      defaultProfileId: "p1",
    });
    vi.mocked(setDefaultProfile).mockResolvedValue({ defaultProfileId: "p2" });
    vi.mocked(duplicateProfile).mockResolvedValue(makeProfile({ id: "p4" }));
    vi.mocked(deleteProfile).mockResolvedValue({ id: "p2" });
  });

  it("renders the profile list with the Default pill on the default row", async () => {
    renderPage();

    expect(await screen.findByDisplayValue("Remote ML")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Berlin backend")).toBeInTheDocument();
    // Exactly one Default pill, and one "Set as default" (on the non-default row).
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Set as default" }),
    ).toHaveLength(1);
  });

  it("navigates to the new-profile editor when Add profile is clicked", async () => {
    renderPage();
    await screen.findByDisplayValue("Remote ML");

    fireEvent.click(screen.getByRole("button", { name: /add profile/i }));

    expect(await screen.findByText("editor-new")).toBeInTheDocument();
  });

  it("sets a profile as default", async () => {
    renderPage();
    await screen.findByDisplayValue("Berlin backend");

    fireEvent.click(screen.getByRole("button", { name: "Set as default" }));

    await waitFor(() => expect(setDefaultProfile).toHaveBeenCalledWith("p2"));
  });

  it("duplicates a profile", async () => {
    renderPage();
    await screen.findByDisplayValue("Remote ML");

    fireEvent.click(screen.getAllByRole("button", { name: /duplicate/i })[0]);

    await waitFor(() => expect(duplicateProfile).toHaveBeenCalledWith("p1"));
  });

  it("surfaces the server error when deleting the last profile", async () => {
    vi.mocked(getProfiles).mockResolvedValue({
      profiles: [profileA],
      defaultProfileId: "p1",
    });
    const message =
      "Cannot delete the last profile — at least one is required.";
    vi.mocked(deleteProfile).mockRejectedValue(new Error(message));

    renderPage();
    await screen.findByDisplayValue("Remote ML");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
  });
});
