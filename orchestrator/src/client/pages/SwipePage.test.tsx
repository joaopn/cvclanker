/**
 * Covers the one part of the deck's duplicate-application wiring that tsc
 * cannot see: the dialog MOUNT. `confirmTailor` is a required prop, so failing
 * to thread it does not compile — but deleting the `<CompanyInFlightDialog>`
 * this page renders compiles fine, keeps every other test green, and hangs a
 * conflicting swipe for ever (the guard parks on a promise whose resolver
 * nothing can reach). That is the same hole the required prop was chosen to
 * avoid, reopened at a new site.
 */

import { createJob } from "@shared/testing/factories";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmTailor } from "./orchestrator/tailorCompanyConflicts";

const { captured } = vi.hoisted(() => ({
  captured: { confirmTailor: null as ConfirmTailor | null },
}));

// Stand in for the deck and keep a handle on the guard it was handed, so the
// test can drive a real conflict through the page's own guard instance.
vi.mock("./swipe/SwipeDeck", () => ({
  SwipeDeck: ({ confirmTailor }: { confirmTailor: ConfirmTailor }) => {
    captured.confirmTailor = confirmTailor;
    return <div data-testid="swipe-deck" />;
  },
}));

vi.mock("@client/components/layout", () => ({
  PageHeader: () => <div data-testid="page-header" />,
}));
vi.mock("@client/components/PipelineProgressStrip", () => ({
  PipelineProgressStrip: () => null,
}));
vi.mock("@client/components/ViewToggle", () => ({ ViewToggle: () => null }));
vi.mock("./orchestrator/ProfileSelect", () => ({ ProfileSelect: () => null }));
vi.mock("./orchestrator/useOrchestratorData", () => ({
  useOrchestratorData: () => ({
    isPipelineRunning: false,
    scheduledRunActive: false,
    setIsPipelineRunning: vi.fn(),
    pipelineTerminalEvent: null,
  }),
}));
vi.mock("./orchestrator/usePipelineControls", () => ({
  usePipelineControls: () => ({
    isCancelling: false,
    runPipelineNow: vi.fn(),
    handleCancelPipeline: vi.fn(),
  }),
}));
vi.mock("./orchestrator/useSelectedProfile", () => ({
  useSelectedProfile: () => ({
    profiles: [],
    selectedProfileIds: [],
    toggleProfile: vi.fn(),
  }),
}));

// The guard is ON, and one Acme job is already in flight.
vi.mock("@client/hooks/useSettings", () => ({
  useSettings: () => ({ companyInFlightCheckEnabled: true }),
}));
const getJobs = vi.fn();
vi.mock("@client/api", () => ({ getJobs: (...a: unknown[]) => getJobs(...a) }));

import { SwipePage } from "./SwipePage";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <MemoryRouter>{children}</MemoryRouter>
  </QueryClientProvider>
);

beforeEach(() => {
  captured.confirmTailor = null;
  getJobs.mockReset();
  getJobs.mockResolvedValue({
    jobs: [createJob({ id: "live", employer: "Acme", status: "applied" })],
  });
});

describe("SwipePage duplicate-application wiring", () => {
  it("hands the deck a guard that opens the page's own dialog", async () => {
    render(<SwipePage />, { wrapper });
    expect(screen.getByTestId("swipe-deck")).toBeInTheDocument();
    expect(captured.confirmTailor).not.toBeNull();

    // A conflicting swipe: the promise must park, and the box must appear.
    let settled = false;
    void captured
      .confirmTailor?.([{ id: "new", employer: "Acme" }])
      .then(() => {
        settled = true;
      });

    await waitFor(() =>
      expect(
        screen.getByText("You already have work in flight at Acme"),
      ).toBeInTheDocument(),
    );
    expect(settled).toBe(false);
  });

  it("settles the parked swipe when the dialog is answered", async () => {
    render(<SwipePage />, { wrapper });

    let approved: string[] | null | "pending" = "pending";
    void captured
      .confirmTailor?.([{ id: "new", employer: "Acme" }])
      .then((ids) => {
        approved = ids;
      });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /tailor anyway/i }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(approved).toBeNull());
  });

  it("does not open a box when nothing at that employer is in flight", async () => {
    render(<SwipePage />, { wrapper });

    let approved: string[] | null | "pending" = "pending";
    void captured
      .confirmTailor?.([{ id: "new", employer: "Globex" }])
      .then((ids) => {
        approved = ids;
      });

    await waitFor(() => expect(approved).toEqual(["new"]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
