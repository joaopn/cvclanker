import { createJob } from "@shared/testing/factories.js";
import type { JobListItem } from "@shared/types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JobRowContent } from "./JobRowContent";

/**
 * The permanent applied mark on a list row. `appliedAt` is stamped once by the
 * server and never cleared, so it survives closure — the badge is what makes a
 * real rejection distinguishable from a job that was never applied to.
 */
describe("JobRowContent applied badge", () => {
  const row = (overrides: Partial<JobListItem>) =>
    render(<JobRowContent job={createJob(overrides) as JobListItem} />);

  it("marks a closed job that was applied to", () => {
    row({
      status: "closed",
      outcome: "rejected",
      appliedAt: "2026-05-01T09:00:00.000Z",
    });

    expect(screen.getByText("Applied")).toBeInTheDocument();
    // The closure chip still renders beside it — the two facts are separate.
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });

  it("leaves a closed job that was never applied to unmarked", () => {
    row({ status: "closed", outcome: "duplicated", appliedAt: null });

    expect(screen.queryByText("Applied")).not.toBeInTheDocument();
  });

  /**
   * D4: the badge row used to be gated on `category || closureReason ||
   * isSkipped`. `reopen` nulls `outcome` and sets `discovered`, so a reopened
   * row that is ALSO unscored satisfies none of those — the badge would have
   * been silently dropped for exactly the case the mark exists to preserve.
   */
  it("marks a reopened, unscored row with no other badge to ride along with", () => {
    row({
      status: "discovered",
      outcome: null,
      suitabilityCategory: null,
      appliedAt: "2026-05-01T09:00:00.000Z",
    });

    expect(screen.getByText("Applied")).toBeInTheDocument();
  });

  it("marks a skipped row that had been applied to", () => {
    row({
      status: "skipped",
      appliedAt: "2026-05-01T09:00:00.000Z",
    });

    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
  });

  /**
   * Suppressed where it would only restate the row's own status: on the Live
   * and Interviewing tabs the status dot and the tab already say it.
   */
  it.each([
    "applied",
    "in_progress",
  ] as const)("does not restate the mark on a %s row", (status) => {
    row({ status, appliedAt: "2026-05-01T09:00:00.000Z" });

    expect(screen.queryByText("Applied")).not.toBeInTheDocument();
  });
});
