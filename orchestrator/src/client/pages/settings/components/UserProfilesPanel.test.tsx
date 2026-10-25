import * as api from "@client/api";
import { reloadApp, waitForServerRestart } from "@client/lib/restart-poll";
import type {
  StoredUserProfile,
  UserProfilesListResponse,
  UserProfileStats,
} from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserProfilesPanel } from "./UserProfilesPanel";

vi.mock("@client/api", () => ({
  getUserProfiles: vi.fn(),
  renameActiveUserProfile: vi.fn(),
  renameStoredUserProfile: vi.fn(),
  activateUserProfile: vi.fn(),
  newUserProfile: vi.fn(),
  importUserProfile: vi.fn(),
  deleteUserProfile: vi.fn(),
  exportUserProfile: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@client/lib/restart-poll", () => ({
  waitForServerRestart: vi.fn(),
  reloadApp: vi.fn(),
}));

const STORED_ID = "11111111-1111-4111-8111-111111111111";
const INVALID_ID = "22222222-2222-4222-8222-222222222222";

const STATS: UserProfileStats = {
  jobsTotal: 12,
  liveJobs: 3,
  cvDocuments: 2,
  searchProfileNames: ["Default"],
  lastUpdatedAt: "2026-07-01T00:00:00.000Z",
};

const STORED: StoredUserProfile = {
  id: STORED_ID,
  name: "Old Search",
  sizeBytes: 1024 * 1024,
  stats: { ...STATS, jobsTotal: 5 },
};

const LIST: UserProfilesListResponse = {
  active: { name: "Default", sizeBytes: 2 * 1024 * 1024, stats: STATS },
  stored: [
    STORED,
    {
      id: INVALID_ID,
      name: INVALID_ID,
      sizeBytes: 100,
      stats: null,
      invalid: true,
      invalidReason: "Not a readable SQLite database",
    },
  ],
};

const RESTART_RESPONSE = {
  message: "restarting",
  restartRequired: true,
  stashedId: "33333333-3333-4333-8333-333333333333",
};

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <UserProfilesPanel layoutMode="panel" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getUserProfiles).mockResolvedValue(structuredClone(LIST));
  vi.mocked(api.activateUserProfile).mockResolvedValue(RESTART_RESPONSE);
  vi.mocked(api.newUserProfile).mockResolvedValue(RESTART_RESPONSE);
  vi.mocked(api.renameActiveUserProfile).mockResolvedValue({ name: "x" });
  vi.mocked(api.renameStoredUserProfile).mockResolvedValue({
    id: STORED_ID,
    name: "x",
  });
  vi.mocked(api.deleteUserProfile).mockResolvedValue({ id: STORED_ID });
  vi.mocked(api.importUserProfile).mockResolvedValue({ ...STORED });
  vi.mocked(api.exportUserProfile).mockResolvedValue(undefined);
  vi.mocked(waitForServerRestart).mockResolvedValue("restarted");
});

describe("UserProfilesPanel", () => {
  it("renders the active card, stored cards, and the invalid flag", async () => {
    renderPanel();

    expect(await screen.findByDisplayValue("Default")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(
      screen.getByText(/12 jobs · 3 live · 2 CVs · search profiles: Default/),
    ).toBeInTheDocument();

    expect(screen.getByDisplayValue("Old Search")).toBeInTheDocument();
    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(
      screen.getByText("Not a readable SQLite database"),
    ).toBeInTheDocument();
    // The invalid card offers no Activate/Export — only the valid stored card
    // has an Activate button.
    expect(screen.getAllByRole("button", { name: /activate/i })).toHaveLength(
      1,
    );
  });

  it("activates a stored profile through the confirm dialog and rides the restart", async () => {
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: /activate/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /switch profile/i }),
    );

    await waitFor(() =>
      expect(api.activateUserProfile).toHaveBeenCalledWith(STORED_ID),
    );
    expect(await screen.findByText("Switching profile…")).toBeInTheDocument();
    await waitFor(() => expect(reloadApp).toHaveBeenCalled());
  });

  it("shows the manual-restart copy when the server never comes back", async () => {
    vi.mocked(waitForServerRestart).mockResolvedValue("timeout");
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: /activate/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /switch profile/i }),
    );

    expect(
      await screen.findByText(/didn't come back/i),
    ).toBeInTheDocument();
    expect(reloadApp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(reloadApp).toHaveBeenCalledTimes(1);
  });

  it("imports a picked file after the staged confirm", async () => {
    const { container } = renderPanel();
    await screen.findByDisplayValue("Default");

    const file = new File(["sqlite bytes"], "other.db");
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(await screen.findByText("other.db")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^import$/i }));

    await waitFor(() =>
      expect(api.importUserProfile).toHaveBeenCalledWith(file),
    );
  });

  it("passes the secrets toggle and the profile id to exports", async () => {
    renderPanel();
    await screen.findByDisplayValue("Default");

    fireEvent.click(screen.getByRole("checkbox"));

    const exportButtons = screen.getAllByRole("button", { name: /export/i });
    // Active card first, then the valid stored card.
    fireEvent.click(exportButtons[0]);
    await waitFor(() =>
      expect(api.exportUserProfile).toHaveBeenCalledWith({
        includeSecrets: true,
        id: undefined,
      }),
    );

    fireEvent.click(exportButtons[1]);
    await waitFor(() =>
      expect(api.exportUserProfile).toHaveBeenCalledWith({
        includeSecrets: true,
        id: STORED_ID,
      }),
    );
  });

  it("renames active and stored profiles on blur, skipping unchanged names", async () => {
    renderPanel();

    const activeInput = await screen.findByDisplayValue("Default");
    fireEvent.blur(activeInput);
    expect(api.renameActiveUserProfile).not.toHaveBeenCalled();

    fireEvent.change(activeInput, { target: { value: "Main hunt" } });
    fireEvent.blur(activeInput);
    await waitFor(() =>
      expect(api.renameActiveUserProfile).toHaveBeenCalledWith("Main hunt"),
    );

    const storedInput = screen.getByDisplayValue("Old Search");
    fireEvent.blur(storedInput);
    fireEvent.change(storedInput, { target: { value: "Archive" } });
    fireEvent.blur(storedInput);
    await waitFor(() =>
      expect(api.renameStoredUserProfile).toHaveBeenCalledWith(
        STORED_ID,
        "Archive",
      ),
    );
    // The unchanged blurs run before the renames, so a call they made has
    // landed by now.
    expect(api.renameActiveUserProfile).toHaveBeenCalledTimes(1);
    expect(api.renameStoredUserProfile).toHaveBeenCalledTimes(1);
  });

  it("deletes a stored profile after the confirm dialog", async () => {
    renderPanel();
    await screen.findByDisplayValue("Default");

    const deleteButtons = screen.getAllByRole("button", { name: /^delete$/i });
    fireEvent.click(deleteButtons[0]);

    fireEvent.click(
      await screen.findByRole("button", { name: /delete profile/i }),
    );
    await waitFor(() =>
      expect(api.deleteUserProfile).toHaveBeenCalledWith(STORED_ID),
    );
  });

  it("starts a fresh unnamed profile through the confirm dialog", async () => {
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: /new profile/i }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /start fresh/i }),
    );

    await waitFor(() =>
      expect(api.newUserProfile).toHaveBeenCalledWith(undefined),
    );
    expect(await screen.findByText("Switching profile…")).toBeInTheDocument();
  });

  it("passes a typed name when starting a fresh profile", async () => {
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: /new profile/i }),
    );
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: /name for the new profile/i,
      }),
      { target: { value: "  Side quest  " } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /start fresh/i }),
    );

    await waitFor(() =>
      expect(api.newUserProfile).toHaveBeenCalledWith("Side quest"),
    );
  });
});
