import type { DuplicateJobGroup, JobListItem } from "@shared/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runJobAction = vi.fn();
const updateJob = vi.fn();

vi.mock("@client/api", () => ({
  runJobAction: (...args: unknown[]) => runJobAction(...args),
  updateJob: (...args: unknown[]) => updateJob(...args),
}));

vi.mock("@client/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DuplicateReviewModal } from "./DuplicateReviewModal";

function jobItem(overrides: Partial<JobListItem> & { id: string }): JobListItem {
  return {
    source: "linkedin",
    sourceLabel: "LinkedIn",
    title: "Senior Data Engineer",
    employer: "Acme Corp",
    jobUrl: `https://example.com/${overrides.id}`,
    applicationLink: null,
    datePosted: null,
    deadline: null,
    salary: null,
    location: null,
    status: "discovered",
    outcome: null,
    closedAt: null,
    suitabilityCategory: null,
    tailoringFailureReason: null,
    jobType: null,
    jobFunction: null,
    salaryMinAmount: null,
    salaryMaxAmount: null,
    salaryCurrency: null,
    repostedAt: null,
    repostCount: 0,
    discoveredAt: "2026-05-01T00:00:00.000Z",
    readyAt: null,
    appliedAt: null,
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  } as JobListItem;
}

const group = (): DuplicateJobGroup => ({
  key: "senior data engineer acme corp",
  title: "Senior Data Engineer",
  employer: "Acme Corp",
  jobs: [
    jobItem({ id: "j1", sourceLabel: "LinkedIn", suitabilityCategory: "good_fit" }),
    jobItem({
      id: "j2",
      sourceLabel: "Indeed",
      suitabilityCategory: "very_good_fit",
    }),
  ],
});

// A second cluster, so the close-all path has more than one group to sweep.
const otherGroup = (): DuplicateJobGroup => ({
  key: "platform engineer globex",
  title: "Platform Engineer",
  employer: "Globex",
  jobs: [
    jobItem({
      id: "g1",
      title: "Platform Engineer",
      employer: "Globex",
      sourceLabel: "LinkedIn",
      suitabilityCategory: "great_fit",
    }),
    jobItem({
      id: "g2",
      title: "Platform Engineer",
      employer: "Globex",
      sourceLabel: "Indeed",
      suitabilityCategory: "good_fit",
    }),
  ],
});

const renderModal = (
  options: { groups?: DuplicateJobGroup[]; maxBulkActionJobs?: number } = {},
) => {
  const pushUndo = vi.fn(
    (_entry: { label: string; restore: () => Promise<void> }) => {},
  );
  const onResolved = vi.fn(() => {});
  const onOpenChange = vi.fn((_open: boolean) => {});
  render(
    <DuplicateReviewModal
      open
      onOpenChange={onOpenChange}
      groups={options.groups ?? [group()]}
      onResolved={onResolved}
      pushUndo={pushUndo}
      maxBulkActionJobs={options.maxBulkActionJobs ?? 1000}
    />,
  );
  return { pushUndo, onResolved, onOpenChange };
};

describe("DuplicateReviewModal", () => {
  beforeEach(() => {
    runJobAction.mockResolvedValue({
      succeeded: 1,
      failed: 0,
      results: [{ jobId: "j1", ok: true, job: {} }],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("pre-selects the best-fit job as keeper", () => {
    renderModal();
    // j2 is very_good_fit → keeper; its row shows the Keep badge.
    const radios = screen.getAllByRole("radio");
    // DOM order matches group.jobs order: [j1, j2].
    expect(radios[1]).toBeChecked();
    expect(radios[0]).not.toBeChecked();
  });

  it("closes the non-keeper jobs and registers undo", async () => {
    const { pushUndo, onResolved } = renderModal();
    fireEvent.click(
      screen.getByRole("button", { name: /Close 1 as duplicate/i }),
    );

    await waitFor(() => expect(runJobAction).toHaveBeenCalledTimes(1));
    expect(runJobAction).toHaveBeenCalledWith({
      action: "mark_duplicated",
      jobIds: ["j1"], // j2 is the keeper
    });
    expect(pushUndo).toHaveBeenCalledTimes(1);
    expect(onResolved).toHaveBeenCalled();
  });

  it("closes the other job when the keeper is changed", async () => {
    renderModal();
    const radios = screen.getAllByRole("radio");
    fireEvent.click(radios[0]); // make j1 the keeper

    fireEvent.click(
      screen.getByRole("button", { name: /Close 1 as duplicate/i }),
    );

    await waitFor(() => expect(runJobAction).toHaveBeenCalledTimes(1));
    expect(runJobAction).toHaveBeenCalledWith({
      action: "mark_duplicated",
      jobIds: ["j2"],
    });
  });

  it("skip advances without calling the action", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /Skip group/i }));
    expect(runJobAction).not.toHaveBeenCalled();
    expect(screen.getByText(/Nothing left to review/i)).toBeInTheDocument();
  });

  describe("close all", () => {
    it("is hidden when the current group is the only one left", () => {
      renderModal();
      expect(
        screen.queryByRole("button", { name: /Close all/i }),
      ).not.toBeInTheDocument();
    });

    it("closes every remaining group's losers in one action", async () => {
      const { pushUndo, onResolved } = renderModal({
        groups: [group(), otherGroup()],
      });

      fireEvent.click(
        screen.getByRole("button", {
          name: /Close all 2 groups \(2 jobs\)/i,
        }),
      );

      await waitFor(() => expect(runJobAction).toHaveBeenCalledTimes(1));
      // j2 (very_good_fit) and g1 (great_fit) are the auto-picked keepers.
      expect(runJobAction).toHaveBeenCalledWith({
        action: "mark_duplicated",
        jobIds: ["j1", "g2"],
      });
      expect(pushUndo).toHaveBeenCalledTimes(1);
      expect(onResolved).toHaveBeenCalled();
      expect(screen.getByText(/Nothing left to review/i)).toBeInTheDocument();
    });

    it("honours a keeper the user changed on the visible group", async () => {
      renderModal({ groups: [group(), otherGroup()] });
      fireEvent.click(screen.getAllByRole("radio")[0]); // make j1 the keeper

      fireEvent.click(screen.getByRole("button", { name: /Close all/i }));

      await waitFor(() => expect(runJobAction).toHaveBeenCalledTimes(1));
      expect(runJobAction).toHaveBeenCalledWith({
        action: "mark_duplicated",
        jobIds: ["j2", "g2"],
      });
    });

    it("leaves a skipped group alone", async () => {
      renderModal({ groups: [group(), otherGroup()] });
      fireEvent.click(screen.getByRole("button", { name: /Skip group/i }));

      // Only one group is left, so close-all is gone — the per-group button is
      // the whole remainder, and the skipped group is not swept back in.
      expect(
        screen.queryByRole("button", { name: /Close all/i }),
      ).not.toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", { name: /Close 1 as duplicate/i }),
      );

      await waitFor(() => expect(runJobAction).toHaveBeenCalledTimes(1));
      expect(runJobAction).toHaveBeenCalledWith({
        action: "mark_duplicated",
        jobIds: ["g2"],
      });
    });

    it("batches whole groups under the bulk-action cap", async () => {
      renderModal({
        groups: [group(), otherGroup()],
        maxBulkActionJobs: 1,
      });

      // Two groups, one loser each, cap of 1: the second group cannot join
      // this batch, and the label says so rather than promising "all".
      const button = screen.getByRole("button", {
        name: /Close 1 of 2 groups \(1 job\)/i,
      });
      fireEvent.click(button);

      await waitFor(() => expect(runJobAction).toHaveBeenCalledTimes(1));
      expect(runJobAction).toHaveBeenCalledWith({
        action: "mark_duplicated",
        jobIds: ["j1"],
      });
      // Advanced by one group, not past everything — the second is still there.
      expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
      expect(
        screen.queryByText(/Nothing left to review/i),
      ).not.toBeInTheDocument();
    });
  });
});
