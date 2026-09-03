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

/**
 * The Easy-Apply flag on a list row. It rides the live-status line, so it is
 * only ever present on a row someone (or a run's refresh step) has checked.
 */
describe("JobRowContent Easy Apply chip", () => {
  const row = (overrides: Partial<JobListItem>) =>
    render(<JobRowContent job={createJob(overrides) as JobListItem} />);

  it("flags an open posting that applies on LinkedIn", () => {
    row({
      liveClosed: false,
      liveApplicants: "20 applicants",
      liveEasyApply: true,
      liveStatusCheckedAt: new Date().toISOString(),
    });

    expect(screen.getByText("Easy Apply")).toBeInTheDocument();
    expect(screen.getByText("20 applicants")).toBeInTheDocument();
  });

  it("stays silent for an offsite posting", () => {
    // `false` is a verdict, not a gap — it just describes most postings, so a
    // chip for it would be noise on nearly every checked row.
    row({
      liveClosed: false,
      liveApplicants: "20 applicants",
      liveEasyApply: false,
      liveStatusCheckedAt: new Date().toISOString(),
    });

    expect(screen.queryByText("Easy Apply")).not.toBeInTheDocument();
  });

  it("stays silent on a closed posting", () => {
    // A closed posting renders no Apply button, so its verdict is null — the
    // chip must not appear even on a row that was checked.
    row({
      liveClosed: true,
      liveApplicants: null,
      liveEasyApply: null,
      liveStatusCheckedAt: new Date().toISOString(),
    });

    expect(screen.queryByText("Easy Apply")).not.toBeInTheDocument();
  });

  it("stays silent on a row nobody has checked", () => {
    row({ liveClosed: null, liveEasyApply: null, liveStatusCheckedAt: null });

    expect(screen.queryByText("Easy Apply")).not.toBeInTheDocument();
  });
});
