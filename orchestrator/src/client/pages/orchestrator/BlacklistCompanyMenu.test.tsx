import { renderWithQueryClient } from "@client/test/renderWithQueryClient";
import type { Profile } from "@shared/types";
import { defaultProfileConfig } from "@shared/types";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getProfiles = vi.fn();
const blockCompanyOnProfiles = vi.fn();
vi.mock("@client/api", () => ({
  getProfiles: (...args: unknown[]) => getProfiles(...args),
  blockCompanyOnProfiles: (...args: unknown[]) =>
    blockCompanyOnProfiles(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
const toastWarning = vi.fn();
vi.mock("@client/lib/toast", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
  },
}));

// Radix Popover cannot open in jsdom (no pointer capture). The shim renders
// inline, but it HONOURS the controlled `open` prop rather than rendering the
// content unconditionally: the component closes itself after a successful
// blacklist, and a shim that always shows the content would make that pass
// whether or not it happens.
const popoverState = vi.hoisted(() => ({
  setOpen: undefined as ((open: boolean) => void) | undefined,
}));
vi.mock("@/components/ui/popover", async () => {
  const react = await import("react");
  const OpenContext = react.createContext(false);
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => {
      popoverState.setOpen = onOpenChange;
      return (
        <OpenContext.Provider value={open === true}>
          {children}
        </OpenContext.Provider>
      );
    },
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
      <button type="button" onClick={() => popoverState.setOpen?.(true)}>
        {children}
      </button>
    ),
    // Scoped so a query can tell the menu's own confirm button apart from the
    // trigger that opened it; the real popover renders in a portal.
    PopoverContent: ({ children }: { children: React.ReactNode }) => {
      const open = react.useContext(OpenContext);
      if (!open) return null;
      return <div data-testid="popover-content">{children}</div>;
    },
  };
});

import { BlacklistCompanyMenu } from "./BlacklistCompanyMenu";

const profile = (
  id: string,
  name: string,
  blockedCompanyKeywords: string[] = [],
): Profile => ({
  id,
  name,
  config: { ...defaultProfileConfig(), blockedCompanyKeywords },
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
});

const menu = () => within(screen.getByTestId("popover-content"));

const openMenu = async (profiles: Profile[], employer = "Acme Corp") => {
  getProfiles.mockResolvedValue({ profiles, defaultProfileId: null });
  const rendered = renderWithQueryClient(
    <BlacklistCompanyMenu employer={employer} />,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Blacklist" })[0]);
  await screen.findByTestId("popover-content");
  return rendered;
};

const confirmButton = () => menu().getByRole("button", { name: /^Blacklist/ });

describe("BlacklistCompanyMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blockCompanyOnProfiles.mockResolvedValue({
      blocked: [],
      alreadyBlocked: [],
    });
  });

  it("blacklists the company on every ticked profile in one call", async () => {
    blockCompanyOnProfiles.mockResolvedValue({
      blocked: [
        { id: "p1", name: "Berlin" },
        { id: "p2", name: "Vienna" },
      ],
      alreadyBlocked: [],
    });
    await openMenu([profile("p1", "Berlin"), profile("p2", "Vienna")]);
    await screen.findByText("Berlin");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Berlin/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Vienna/ }));
    expect(confirmButton()).toHaveTextContent("Blacklist on 2 profiles");
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(blockCompanyOnProfiles).toHaveBeenCalledTimes(1);
    });
    expect(blockCompanyOnProfiles).toHaveBeenCalledWith({
      employer: "Acme Corp",
      profileIds: ["p1", "p2"],
    });
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });
  });

  it("leaves a profile that already blocks the company ticked and untouchable", async () => {
    await openMenu([
      profile("p1", "Berlin"),
      profile("p2", "Vienna", ["acme corp"]),
    ]);
    await screen.findByText("Vienna");

    const already = screen.getByRole("checkbox", { name: /^Vienna/ });
    expect(already).toBeDisabled();
    expect(already).toBeChecked();
    expect(screen.getByText("Already blocked")).toBeInTheDocument();
  });

  it("names the broader keyword doing the blocking", async () => {
    await openMenu([
      profile("p1", "Berlin"),
      profile("p2", "Vienna", ["acme"]),
    ]);
    await screen.findByText("Vienna");

    expect(screen.getByText('Already blocked by "acme"')).toBeInTheDocument();
  });

  it("keeps the confirm button dead until something new is ticked", async () => {
    await openMenu([profile("p1", "Berlin", ["acme corp"])]);
    await screen.findByText("Berlin");

    expect(confirmButton()).toBeDisabled();
  });

  it("closes the menu and refreshes the profiles on success", async () => {
    blockCompanyOnProfiles.mockResolvedValue({
      blocked: [{ id: "p1", name: "Berlin" }],
      alreadyBlocked: [],
    });
    const { queryClient } = await openMenu([profile("p1", "Berlin")]);
    await screen.findByText("Berlin");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Berlin/ }));
    fireEvent.click(confirmButton());

    // Leaving it open would show a list that no longer matches the server,
    // with the confirm button live against ids it has already written.
    await waitFor(() => {
      expect(screen.queryByTestId("popover-content")).not.toBeInTheDocument();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["profiles"] });
  });

  it("does not claim a change when every ticked profile already blocked it", async () => {
    blockCompanyOnProfiles.mockResolvedValue({
      blocked: [],
      alreadyBlocked: [{ id: "p1", name: "Berlin", keyword: "acme corp" }],
    });
    await openMenu([profile("p1", "Berlin")]);
    await screen.findByText("Berlin");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Berlin/ }));
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(toastInfo).toHaveBeenCalledWith(
        "Acme Corp was already blacklisted.",
      );
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("still reports the write when only some of the ticks were new", async () => {
    blockCompanyOnProfiles.mockResolvedValue({
      blocked: [{ id: "p1", name: "Berlin" }],
      alreadyBlocked: [{ id: "p2", name: "Vienna", keyword: "acme corp" }],
    });
    await openMenu([profile("p1", "Berlin"), profile("p2", "Vienna")]);
    await screen.findByText("Berlin");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Berlin/ }));
    fireEvent.click(confirmButton());

    // The commonest real mix: one profile written, one already covered. The
    // write is what the user must be told about.
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalled();
    });
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("does not claim an already-blacklisted company when the profiles vanished", async () => {
    blockCompanyOnProfiles.mockResolvedValue({
      blocked: [],
      alreadyBlocked: [],
    });
    await openMenu([profile("p1", "Berlin")]);
    await screen.findByText("Berlin");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Berlin/ }));
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(toastWarning).toHaveBeenCalled();
    });
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("drops a tick that the refreshed list shows as already blocked", async () => {
    const { queryClient } = await openMenu([profile("p1", "Berlin")]);
    await screen.findByText("Berlin");
    fireEvent.click(screen.getByRole("checkbox", { name: /^Berlin/ }));
    expect(confirmButton()).toBeEnabled();

    // The list can move under an open menu (another tab, the profile editor).
    getProfiles.mockResolvedValue({
      profiles: [profile("p1", "Berlin", ["acme corp"])],
      defaultProfileId: null,
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["profiles", "list"] });
    });

    await screen.findByText("Already blocked");
    expect(confirmButton()).toBeDisabled();
  });

  it("refuses a company name too long to store as a keyword", async () => {
    await openMenu([profile("p1", "Berlin")], "A".repeat(201));

    expect(screen.getByText(/longer than 200 characters/i)).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("accepts a company name of exactly the keyword length", async () => {
    // The server stores this one, so refusing it here would be the UI
    // inventing a stricter rule than the thing it is a face for.
    await openMenu([profile("p1", "Berlin")], "A".repeat(200));
    await screen.findByText("Berlin");

    expect(screen.queryByText(/longer than 200 characters/i)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Berlin/ }));
    expect(confirmButton()).toBeEnabled();
  });

  it("forgets the ticks when the menu closes", async () => {
    await openMenu([profile("p1", "Berlin")]);
    await screen.findByText("Berlin");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Berlin/ }));
    expect(confirmButton()).toBeEnabled();

    // Reopening must not carry a stale selection into a list whose blocked
    // keywords have moved on since.
    act(() => popoverState.setOpen?.(false));
    act(() => popoverState.setOpen?.(true));

    expect(screen.getByRole("checkbox", { name: /^Berlin/ })).not.toBeChecked();
    expect(confirmButton()).toBeDisabled();
  });

  it("surfaces a failed blacklist instead of reporting success", async () => {
    blockCompanyOnProfiles.mockRejectedValue(new Error("Profile not found"));
    await openMenu([profile("p1", "Berlin")]);
    await screen.findByText("Berlin");

    fireEvent.click(screen.getByRole("checkbox", { name: /^Berlin/ }));
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Profile not found");
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
