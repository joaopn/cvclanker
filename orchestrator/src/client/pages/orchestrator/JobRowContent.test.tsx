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
   *
   * The word still reaches those rows — the date pill reads "Applied 12d"
   * there (see the date-pill block below), which is why this asserts the bare
   * BADGE text: the text matchers match exactly, so "Applied 12d" is not
   * "Applied". The two are one design, not a contradiction — do not "fix"
   * either by making the other say something else.
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
 * The row's single date pill. It reports the most useful measure the row has,
 * which on a row whose status already says "applied" is how long ago the
 * application went out rather than how old the posting is.
 */
describe("JobRowContent date pill", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  /**
   * Half a day of slack, so the floored day count cannot tip over while the
   * test runs — asserting a value an accumulator reaches exactly is B20.
   */
  const daysAgo = (days: number) =>
    new Date(Date.now() - days * DAY_MS - DAY_MS / 2).toISOString();

  const row = (overrides: Partial<JobListItem>) =>
    render(<JobRowContent job={createJob(overrides) as JobListItem} />);

  it.each([
    "applied",
    "in_progress",
  ] as const)("reports the application date on a %s row", (status) => {
    row({ status, appliedAt: daysAgo(12), datePosted: daysAgo(60) });

    expect(screen.getByText("Applied 12d")).toBeInTheDocument();
    expect(screen.queryByText("Posted 60d")).not.toBeInTheDocument();
  });

  it("hangs the exact application date off the pill", () => {
    // The Applied badge normally carries this tooltip, and it is suppressed on
    // exactly the rows the pill swaps on — so the pill is the only place the
    // date is still reachable.
    const appliedAt = daysAgo(12);
    row({ status: "applied", appliedAt, datePosted: daysAgo(60) });

    expect(screen.getByText("Applied 12d")).toHaveAttribute(
      "title",
      `Applied ${new Date(appliedAt).toLocaleDateString()}`,
    );
  });

  it("keeps the posting date on a closed row that was applied to", () => {
    // The badge renders there and carries the date itself, so the pill is free
    // to go on describing the posting.
    row({
      status: "closed",
      outcome: "rejected",
      appliedAt: daysAgo(12),
      datePosted: daysAgo(60),
    });

    // ...and the tooltip goes with it: an "Applied <date>" title on a pill
    // reading "Posted 60d" would describe a different date than its own label.
    expect(screen.getByText("Posted 60d")).not.toHaveAttribute("title");
    expect(screen.getByText("Applied")).toBeInTheDocument();
  });

  it("ages a reopened row carrying the mark by its posting date", () => {
    // The pill's day count is also what the Inbox stale marker reads, and that
    // marker is gated on `discovered` — a reopened row keeps its permanent
    // applied mark, so measuring from the application would silently un-stale
    // an old posting.
    render(
      <JobRowContent
        job={
          createJob({
            status: "discovered",
            outcome: null,
            appliedAt: daysAgo(12),
            datePosted: daysAgo(60),
          }) as JobListItem
        }
        staleThresholdDays={30}
      />,
    );

    const pill = screen.getByText("Posted 60d");
    expect(pill).toBeInTheDocument();
    expect(pill.className).toContain("text-muted-foreground/70");
  });

  it("falls back to the posting date when the stamp is missing", () => {
    // A legacy row the boot backfill could find no usable timestamp for still
    // sits on the Live tab; it must not lose its date pill.
    row({ status: "applied", appliedAt: null, datePosted: daysAgo(60) });

    expect(screen.getByText("Posted 60d")).toBeInTheDocument();
  });

  it("falls back to the posting date when the stamp will not parse", () => {
    row({ status: "applied", appliedAt: "whenever", datePosted: daysAgo(60) });

    expect(screen.getByText("Posted 60d")).toBeInTheDocument();
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
