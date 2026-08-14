import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FloatingJobActionsBar } from "./FloatingJobActionsBar";

const noop = () => {};

function renderBar(
  overrides: Partial<React.ComponentProps<typeof FloatingJobActionsBar>> = {},
) {
  const onDelete = vi.fn();
  render(
    <FloatingJobActionsBar
      activeTab="inbox"
      selectedCount={2}
      canMoveSelected={false}
      canSkipSelected={false}
      canRescoreSelected={false}
      canClearScoreSelected={false}
      canRescrapeSelected={false}
      canMoveToBacklogSelected={false}
      canMoveToStaleSelected={false}
      canMoveToInboxSelected={false}
      canMarkClosedSelected={false}
      canReopenSelected={false}
      canDeleteSelected
      hasScorerPrefilter={false}
      jobActionInFlight={false}
      onMoveToReady={noop}
      onSkipSelected={noop}
      onRescoreSelected={noop}
      onScreenRescoreSelected={noop}
      onClearScoreSelected={noop}
      onRescrapeSelected={noop}
      onMoveToBacklog={noop}
      onMoveToStale={noop}
      onMoveToInbox={noop}
      onMarkClosed={noop}
      onReopen={noop}
      onDelete={onDelete}
      onClear={noop}
      {...overrides}
    />,
  );
  return { onDelete };
}

describe("FloatingJobActionsBar delete", () => {
  it("does not delete on the first click — it opens a confirmation", () => {
    const { onDelete } = renderBar();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("deletes once the confirmation is accepted", () => {
    const { onDelete } = renderBar();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete 2 jobs$/ }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("cancelling leaves the jobs alone", () => {
    const { onDelete } = renderBar();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("offers delete on a tab with no other actions", () => {
    // The button lives outside the per-tab switch on purpose: every tab where a
    // row can be selected gets the same escape hatch.
    renderBar({ activeTab: "closed" });
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("hides delete when the selection holds a live tailor", () => {
    renderBar({ canDeleteSelected: false });
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });

  describe("screened rescore", () => {
    it("offers only the plain button when no pre-filter is configured", () => {
      renderBar({ canRescoreSelected: true, hasScorerPrefilter: false });

      expect(
        screen.getByRole("button", { name: "Recalculate match" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Screen first" }),
      ).not.toBeInTheDocument();
    });

    it("offers both behaviours as separate buttons once one is", () => {
      const onRescoreSelected = vi.fn();
      const onScreenRescoreSelected = vi.fn();
      renderBar({
        canRescoreSelected: true,
        hasScorerPrefilter: true,
        onRescoreSelected,
        onScreenRescoreSelected,
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Recalculate match" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Screen first" }));

      // Separate handlers: the plain button must never route through the screen.
      expect(onRescoreSelected).toHaveBeenCalledTimes(1);
      expect(onScreenRescoreSelected).toHaveBeenCalledTimes(1);
    });

    it("shows neither when the selection cannot be rescored", () => {
      renderBar({ canRescoreSelected: false, hasScorerPrefilter: true });

      expect(
        screen.queryByRole("button", { name: "Recalculate match" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Screen first" }),
      ).not.toBeInTheDocument();
    });

    it("carries both buttons onto every tab that offers rescoring", () => {
      // They were four copy-pasted blocks before; one shared fragment now.
      for (const activeTab of [
        "inbox",
        "tailoring",
        "backlog",
        "all",
      ] as const) {
        renderBar({
          activeTab,
          canRescoreSelected: true,
          hasScorerPrefilter: true,
        });
        expect(
          screen.getByRole("button", { name: "Recalculate match" }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: "Screen first" }),
        ).toBeInTheDocument();
        cleanup();
      }
    });
  });
});
