import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import type { Profile } from "@shared/types";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getProfiles, setSourcePinOnAllProfiles, toast } = vi.hoisted(() => ({
  getProfiles: vi.fn(),
  setSourcePinOnAllProfiles: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@client/api", () => ({ getProfiles, setSourcePinOnAllProfiles }));
vi.mock("@client/lib/toast", () => ({ toast }));

import { AllProfilesPinControl } from "./AllProfilesPinControl";

function profile(
  id: string,
  enabledSourceIds: string[],
  remoteProfile = false,
): Profile {
  return {
    id,
    name: id,
    config: { enabledSourceIds, providerInstanceIds: [], remoteProfile },
    createdAt: "",
    updatedAt: "",
  } as unknown as Profile;
}

function renderControl(enabledHere = true) {
  return renderWithQueryClient(
    <AllProfilesPinControl
      kind="extractor"
      sourceId="jobspy"
      displayName="JobSpy"
      enabledHere={enabledHere}
    />,
  );
}

describe("AllProfilesPinControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProfiles.mockResolvedValue({
      profiles: [
        profile("Berlin", ["jobspy"]),
        profile("Vienna", []),
        profile("Madrid", ["hiringcafe"]),
      ],
      defaultProfileId: null,
    });
    setSourcePinOnAllProfiles.mockResolvedValue({
      changed: [],
      unchanged: [],
      skipped: [],
      empty: [],
    });
  });

  it("counts the profiles that pin the source", async () => {
    renderControl();
    expect(
      await screen.findByText("Enabled in 1 of 3 Search Profiles"),
    ).toBeInTheDocument();
  });

  it("enables the source in every profile in one press", async () => {
    setSourcePinOnAllProfiles.mockResolvedValue({
      changed: [
        { id: "Vienna", name: "Vienna" },
        { id: "Madrid", name: "Madrid" },
      ],
      unchanged: [{ id: "Berlin", name: "Berlin" }],
      skipped: [],
      empty: [],
    });
    renderControl();
    await screen.findByText("Enabled in 1 of 3 Search Profiles");

    fireEvent.click(
      screen.getByRole("button", { name: "Enable in all profiles" }),
    );

    await waitFor(() =>
      expect(setSourcePinOnAllProfiles).toHaveBeenCalledWith({
        kind: "extractor",
        sourceId: "jobspy",
        pinned: true,
      }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Enabled JobSpy in 2 profiles",
      ),
    );
  });

  it("asks before disabling, and warns about profiles left with no source", async () => {
    setSourcePinOnAllProfiles.mockResolvedValue({
      changed: [{ id: "Berlin", name: "Berlin" }],
      unchanged: [],
      skipped: [],
      empty: [{ id: "Berlin", name: "Berlin" }],
    });
    renderControl();
    await screen.findByText("Enabled in 1 of 3 Search Profiles");

    fireEvent.click(
      screen.getByRole("button", { name: "Disable in all profiles" }),
    );
    expect(setSourcePinOnAllProfiles).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "Disable in all profiles",
      ) as HTMLButtonElement,
    );

    await waitFor(() =>
      expect(setSourcePinOnAllProfiles).toHaveBeenCalledWith({
        kind: "extractor",
        sourceId: "jobspy",
        pinned: false,
      }),
    );
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(toast.warning.mock.calls[0][0]).toContain(
      "Berlin now has no sources",
    );
  });

  it("disables each button when there is nothing for it to do", async () => {
    getProfiles.mockResolvedValue({
      profiles: [profile("Berlin", ["jobspy"])],
      defaultProfileId: null,
    });
    renderControl();
    await screen.findByText("Enabled in 1 of 1 Search Profile");

    expect(
      screen.getByRole("button", { name: "Enable in all profiles" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Disable in all profiles" }),
    ).toBeEnabled();
  });

  it("says when the source is switched off on this page", async () => {
    const { rerender } = renderControl(false);
    expect(
      await screen.findByText(/This source is switched off above/),
    ).toBeInTheDocument();
    rerender(
      <AllProfilesPinControl
        kind="extractor"
        sourceId="jobspy"
        displayName="JobSpy"
        enabledHere
      />,
    );
    expect(screen.queryByText(/This source is switched off above/)).toBeNull();
  });
  it("asks before enabling a paid Apify actor everywhere", async () => {
    getProfiles.mockResolvedValue({
      profiles: [profile("Berlin", []), profile("Vienna", [])],
      defaultProfileId: null,
    });
    renderWithQueryClient(
      <AllProfilesPinControl
        kind="provider_instance"
        sourceId="inst-1"
        displayName="LinkedIn"
        enabledHere
      />,
    );
    await screen.findByText("Enabled in 0 of 2 Search Profiles");

    fireEvent.click(
      screen.getByRole("button", { name: "Enable in all profiles" }),
    );
    expect(setSourcePinOnAllProfiles).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Apify actors are paid");
    fireEvent.click(
      Array.from(dialog.querySelectorAll("button")).find(
        (button) => button.textContent === "Enable in all profiles",
      ) as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(setSourcePinOnAllProfiles).toHaveBeenCalledWith({
        kind: "provider_instance",
        sourceId: "inst-1",
        pinned: true,
      }),
    );
  });

  it("counts only remote profiles for a remote-only board, and names the ones it skipped", async () => {
    getProfiles.mockResolvedValue({
      profiles: [
        profile("Remote", ["himalayas"], true),
        profile("Vienna", ["jobspy"]),
      ],
      defaultProfileId: null,
    });
    setSourcePinOnAllProfiles.mockResolvedValue({
      changed: [],
      unchanged: [{ id: "Remote", name: "Remote" }],
      skipped: [{ id: "Vienna", name: "Vienna" }],
      empty: [],
    });
    renderWithQueryClient(
      <AllProfilesPinControl
        kind="extractor"
        sourceId="himalayas"
        displayName="Himalayas"
        enabledHere
      />,
    );

    // Vienna can never take it, so it is not "1 of 2" with Enable left live.
    expect(
      await screen.findByText("Enabled in 1 of 1 remote Search Profile"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Enable in all profiles" }),
    ).toBeDisabled();
  });

  it("keeps a stale remote-only pin on a non-remote profile clearable", async () => {
    // New profiles are auto-filled with every enabled source, remote-only
    // boards included, so a non-remote profile pinning one is ordinary.
    getProfiles.mockResolvedValue({
      profiles: [profile("Vienna", ["jobspy", "himalayas"])],
      defaultProfileId: null,
    });
    renderWithQueryClient(
      <AllProfilesPinControl
        kind="extractor"
        sourceId="himalayas"
        displayName="Himalayas"
        enabledHere
      />,
    );

    expect(
      await screen.findByText(
        "Enabled in 0 of 0 remote Search Profiles (also on 1 non-remote profile, where it never runs)",
      ),
    ).toBeInTheDocument();
    // No remote profile to add it to, so Enable has nothing to do...
    expect(
      screen.getByRole("button", { name: "Enable in all profiles" }),
    ).toBeDisabled();
    // ...but Vienna's pin can still be removed.
    fireEvent.click(
      screen.getByRole("button", { name: "Disable in all profiles" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "removed from the sources of 1 Search Profile.",
    );
  });

  it("reports skipped profiles without claiming the source is enabled everywhere, and refreshes run options", async () => {
    setSourcePinOnAllProfiles.mockResolvedValue({
      changed: [],
      unchanged: [],
      skipped: [{ id: "Vienna", name: "Vienna" }],
      empty: [],
    });
    const { queryClient } = renderControl();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await screen.findByText("Enabled in 1 of 3 Search Profiles");

    fireEvent.click(
      screen.getByRole("button", { name: "Enable in all profiles" }),
    );

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "Not added to Vienna: JobSpy only runs on a remote profile.",
      ),
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["run-options"] });
  });

  it("offers neither button when the profiles cannot be loaded", async () => {
    getProfiles.mockRejectedValue(new Error("boom"));
    renderControl();
    expect(
      await screen.findByText("Could not load Search Profiles"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Enable in all profiles" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Disable in all profiles" }),
    ).toBeDisabled();
  });
});
