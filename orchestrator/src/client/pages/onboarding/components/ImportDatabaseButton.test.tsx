import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { reloadApp, waitForServerRestart } from "@client/lib/restart-poll";
import { toast } from "@client/lib/toast";
import type { StoredUserProfile } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportDatabaseButton } from "./ImportDatabaseButton";

// A partial factory is safe only because `useProfileSwitch` reaches `api.*`
// inside arrow functions — a vitest mock module THROWS on property access of an
// export the factory omits, so a direct reference there would break this.
vi.mock("@client/api", () => ({
  importUserProfile: vi.fn(),
  activateUserProfile: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@client/lib/restart-poll", () => ({
  waitForServerRestart: vi.fn(),
  reloadApp: vi.fn(),
}));

const IMPORTED: StoredUserProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Main hunt",
  sizeBytes: 4096,
  stats: null,
};

function renderButton(disabled?: boolean) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  return {
    invalidate,
    ...render(
      <QueryClientProvider client={client}>
        <ImportDatabaseButton disabled={disabled} />
      </QueryClientProvider>,
    ),
  };
}

function pickFile(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
}

const FILE = new File(["sqlite bytes"], "carried-over.db");

describe("ImportDatabaseButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.importUserProfile).mockResolvedValue(IMPORTED);
    vi.mocked(api.activateUserProfile).mockResolvedValue({
      message: "restarting",
      restartRequired: true,
      stashedId: "22222222-2222-4222-8222-222222222222",
    });
    vi.mocked(waitForServerRestart).mockResolvedValue("restarted");
  });

  it("stages a confirm naming the picked file without calling the API", async () => {
    const { container } = renderButton();
    pickFile(container, FILE);

    expect(
      await screen.findByText(/Import "carried-over\.db" and switch to it\?/),
    ).toBeInTheDocument();
    expect(api.importUserProfile).not.toHaveBeenCalled();
  });

  it("imports then activates then rides the restart", async () => {
    const { container } = renderButton();
    pickFile(container, FILE);
    fireEvent.click(
      await screen.findByRole("button", { name: /import and switch/i }),
    );

    await waitFor(() =>
      expect(api.importUserProfile).toHaveBeenCalledWith(FILE),
    );
    await waitFor(() =>
      expect(api.activateUserProfile).toHaveBeenCalledWith(IMPORTED.id),
    );
    expect(await screen.findByText(/Switching profile/)).toBeInTheDocument();
    await waitFor(() => expect(reloadApp).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /switch to "Main hunt"/i }),
    ).not.toBeInTheDocument();
  });

  // The drawer switcher is the only way back to an imported database from
  // behind the onboarding gate, and its listing is cached.
  it("refreshes the cached profile listing on import", async () => {
    const { container, invalidate } = renderButton();
    pickFile(container, FILE);
    fireEvent.click(
      await screen.findByRole("button", { name: /import and switch/i }),
    );

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.userProfiles.all,
      }),
    );
  });

  it("cancelling the confirm imports nothing", async () => {
    const { container } = renderButton();
    pickFile(container, FILE);
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByText(/and switch to it\?/)).not.toBeInTheDocument(),
    );
    expect(api.importUserProfile).not.toHaveBeenCalled();
    expect(api.activateUserProfile).not.toHaveBeenCalled();
  });

  it("surfaces a failed import and never activates", async () => {
    vi.mocked(api.importUserProfile).mockRejectedValue(
      new Error("Not a readable SQLite database"),
    );
    const { container } = renderButton();
    pickFile(container, FILE);
    fireEvent.click(
      await screen.findByRole("button", { name: /import and switch/i }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Not a readable SQLite database",
      ),
    );
    expect(api.activateUserProfile).not.toHaveBeenCalled();
    expect(waitForServerRestart).not.toHaveBeenCalled();
  });

  it("offers a retry when the import lands but the switch is refused", async () => {
    vi.mocked(api.activateUserProfile).mockRejectedValue(
      new Error("Cannot switch while a pipeline run is in flight."),
    );
    const { container } = renderButton();
    pickFile(container, FILE);
    fireEvent.click(
      await screen.findByRole("button", { name: /import and switch/i }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Cannot switch while a pipeline run is in flight.",
      ),
    );
    expect(waitForServerRestart).not.toHaveBeenCalled();
    expect(reloadApp).not.toHaveBeenCalled();

    const retry = await screen.findByRole("button", {
      name: /switch to "Main hunt"/i,
    });
    vi.mocked(api.activateUserProfile).mockResolvedValue({
      message: "restarting",
      restartRequired: true,
      stashedId: "22222222-2222-4222-8222-222222222222",
    });
    fireEvent.click(retry);

    await waitFor(() =>
      expect(api.activateUserProfile).toHaveBeenCalledTimes(2),
    );
    await waitFor(() => expect(reloadApp).toHaveBeenCalled());
  });

  // The export checkbox is off by default, and a secrets-stripped file cannot
  // satisfy the onboarding gate — so the precondition has to be stated where
  // the file is chosen, not only after it fails.
  it("states the include-secrets precondition before a file is picked", () => {
    renderButton();
    expect(
      screen.getByText(/ticked\. That box is off by default/i),
    ).toBeInTheDocument();
  });

  it("disables the trigger while the wizard is busy", () => {
    renderButton(true);
    expect(
      screen.getByRole("button", { name: /import database/i }),
    ).toBeDisabled();
  });

  // Activation closes the DB and exits the process; a busy wizard has writes
  // in flight, so the retry path needs the same gate as the trigger.
  it("disables the switch retry while the wizard is busy", async () => {
    vi.mocked(api.activateUserProfile).mockRejectedValue(new Error("nope"));
    const { container } = renderButton(true);
    // `disabled` gates the trigger, not the dialog, so drive the import
    // through the file input directly to reach the retry state.
    pickFile(container, FILE);
    fireEvent.click(
      await screen.findByRole("button", { name: /import and switch/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /switch to "Main hunt"/i }),
      ).toBeDisabled(),
    );
  });
});
