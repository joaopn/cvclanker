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
      canFetchLiveStatusSelected={false}
      canRetailorSelected={false}
      retailorableCount={0}
      activeCvName={null}
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
      onFetchLiveStatus={noop}
      onRetailor={noop}
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

  describe("live status", () => {
    it("offers the button on every tab when the selection qualifies", () => {
      // Outside the per-tab switch like Delete: every tab gets it, gated only
      // on the selection carrying LinkedIn posting ids.
      for (const activeTab of ["inbox", "live", "closed", "all"] as const) {
        renderBar({ activeTab, canFetchLiveStatusSelected: true });
        expect(
          screen.getByRole("button", { name: "Live status" }),
        ).toBeInTheDocument();
        cleanup();
      }
    });

    it("hides the button when a selected job has no LinkedIn id", () => {
      renderBar({ canFetchLiveStatusSelected: false });
      expect(
        screen.queryByRole("button", { name: "Live status" }),
      ).not.toBeInTheDocument();
    });

    it("fires the handler on click", () => {
      const onFetchLiveStatus = vi.fn();
      renderBar({ canFetchLiveStatusSelected: true, onFetchLiveStatus });

      fireEvent.click(screen.getByRole("button", { name: "Live status" }));

      expect(onFetchLiveStatus).toHaveBeenCalledTimes(1);
    });
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

  describe("Generate (bulk re-tailor)", () => {
    it("quotes the ELIGIBLE subset, not the whole selection, and says what is skipped", () => {
      renderBar({
        activeTab: "tailoring",
        selectedCount: 5,
        canRetailorSelected: true,
        retailorableCount: 3,
        activeCvName: "Jane Doe CV",
      });

      fireEvent.click(screen.getByRole("button", { name: /generate 3 jobs/i }));

      expect(screen.getByText(/re-tailor 3 jobs\?/i)).toBeTruthy();
      expect(screen.getByText(/"Jane Doe CV"/)).toBeTruthy();
      expect(
        screen.getByText(/2 of the 5 selected are being tailored right now/i),
      ).toBeTruthy();
    });

    it("omits the skipped-rows note when every selected row is eligible", () => {
      renderBar({
        activeTab: "tailoring",
        selectedCount: 2,
        canRetailorSelected: true,
        retailorableCount: 2,
      });

      fireEvent.click(screen.getByRole("button", { name: /generate 2 jobs/i }));

      expect(screen.queryByText(/will be skipped/i)).toBeNull();
      // No CV name known — the copy falls back rather than rendering "".
      expect(screen.getByText(/the active CV/i)).toBeTruthy();
    });

    it("fires only on confirm, never on the trigger", () => {
      const onRetailor = vi.fn();
      renderBar({
        activeTab: "tailoring",
        selectedCount: 1,
        canRetailorSelected: true,
        retailorableCount: 1,
        onRetailor,
      });

      fireEvent.click(screen.getByRole("button", { name: /generate 1 job/i }));
      expect(onRetailor).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole("button", { name: /^generate 1 job$/i }),
      );
      expect(onRetailor).toHaveBeenCalledTimes(1);
    });

    // Both buttons would quote the same count and do the same thing here, and
    // only Generate confirms the spend first.
    it("is the only tailoring entrance — no Tailor button beside it", () => {
      renderBar({
        activeTab: "tailoring",
        selectedCount: 3,
        canMoveSelected: true,
        canRetailorSelected: true,
        retailorableCount: 3,
      });

      expect(screen.queryByRole("button", { name: /^tailor /i })).toBeNull();
      expect(
        screen.getByRole("button", { name: /generate 3 jobs/i }),
      ).toBeTruthy();
    });

    // Tailor still owns the untailored shelves everywhere else — `all`
    // included, which is why the spend confirmation is tab-local, not global.
    it("leaves the Tailor button alone on other tabs", () => {
      for (const tab of ["inbox", "backlog", "stale", "all"] as const) {
        cleanup();
        renderBar({ activeTab: tab, selectedCount: 3, canMoveSelected: true });
        expect(
          screen.getByRole("button", { name: /^tailor 3 jobs$/i }),
        ).toBeTruthy();
      }
    });

    it("is absent when nothing selected is eligible", () => {
      renderBar({
        activeTab: "tailoring",
        canRetailorSelected: false,
        retailorableCount: 0,
      });

      expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
    });

    // Re-tailoring is only reachable where tailored rows live.
    it("is absent on other tabs even when the selection qualifies", () => {
      for (const tab of ["inbox", "backlog", "closed"] as const) {
        cleanup();
        renderBar({
          activeTab: tab,
          canRetailorSelected: true,
          retailorableCount: 2,
        });
        expect(screen.queryByRole("button", { name: /generate/i })).toBeNull();
      }
    });
  });
});
