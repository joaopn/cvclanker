import type { CreateJobInput } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureRunJobs,
  getRunJobs,
  resetAllRunJobCaptures,
  resetRunJobCapture,
  resetRunJobCaptureForSource,
  setRunCaptureScope,
  setRunCaptureTrigger,
  toCapturedRunJob,
} from "./run-job-capture";

function makeInput(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    source: "linkedin",
    title: "Engineer",
    employer: "Acme",
    jobUrl: "https://example.com/job/1",
    ...overrides,
  };
}

/**
 * `resetAllRunJobCaptures` clears the ACTIVE partition only, so a reset that
 * did not visit both would let a scheduled-run test leak into the next file.
 */
function resetEveryPartition() {
  for (const trigger of ["manual", "schedule"] as const) {
    setRunCaptureTrigger(trigger);
    resetAllRunJobCaptures();
  }
  setRunCaptureTrigger("manual");
}

describe("run-job-capture", () => {
  beforeEach(resetEveryPartition);

  it("captures jobs per source and bucket and reads them back", () => {
    captureRunJobs("linkedin", "scraped", [
      toCapturedRunJob(makeInput({ jobUrl: "u1" })),
      toCapturedRunJob(makeInput({ jobUrl: "u2" })),
    ]);
    captureRunJobs("linkedin", "imported", [
      toCapturedRunJob(makeInput({ jobUrl: "u1" })),
    ]);

    expect(getRunJobs("linkedin", "scraped")).toHaveLength(2);
    expect(getRunJobs("linkedin", "imported")).toHaveLength(1);
    expect(getRunJobs("linkedin", "duplicated")).toEqual([]);
    expect(getRunJobs("indeed", "scraped")).toEqual([]);
  });

  it("appends across calls and carries a rejection reason", () => {
    captureRunJobs("indeed", "rejected", [
      toCapturedRunJob(makeInput(), "location mismatch"),
    ]);
    captureRunJobs("indeed", "rejected", [
      toCapturedRunJob(makeInput({ jobUrl: "u3" }), "bad data"),
    ]);

    const rejected = getRunJobs("indeed", "rejected");
    expect(rejected).toHaveLength(2);
    expect(rejected.map((job) => job.reason)).toEqual([
      "location mismatch",
      "bad data",
    ]);
  });

  it("reset clears everything", () => {
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);
    resetRunJobCapture();
    expect(getRunJobs("linkedin", "scraped")).toEqual([]);
  });

  it("keeps each profile's captures on its own page", () => {
    setRunCaptureScope("profile-a");
    captureRunJobs("linkedin", "scraped", [
      toCapturedRunJob(makeInput({ jobUrl: "a1" })),
    ]);
    setRunCaptureScope("profile-b");
    captureRunJobs("linkedin", "scraped", [
      toCapturedRunJob(makeInput({ jobUrl: "b1" })),
      toCapturedRunJob(makeInput({ jobUrl: "b2" })),
    ]);

    expect(getRunJobs("linkedin", "scraped", "profile-a")).toHaveLength(1);
    expect(getRunJobs("linkedin", "scraped", "profile-b")).toHaveLength(2);
    // Reading without a scope must not fall through to whichever profile is
    // running — that is what would answer page 1 with page 2's jobs.
    expect(getRunJobs("linkedin", "scraped")).toEqual([]);
  });

  it("a profile's own reset leaves the pages before it intact", () => {
    setRunCaptureScope("profile-a");
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);
    setRunCaptureScope("profile-b");
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);
    // Every profile of a chain starts a run, and a run resets its captures.
    resetRunJobCapture();

    expect(getRunJobs("linkedin", "scraped", "profile-b")).toEqual([]);
    expect(getRunJobs("linkedin", "scraped", "profile-a")).toHaveLength(1);
  });

  it("scopes the per-source reset to the running profile", () => {
    setRunCaptureScope("profile-a");
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);
    setRunCaptureScope("profile-b");
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);
    resetRunJobCaptureForSource("linkedin");

    expect(getRunJobs("linkedin", "scraped", "profile-b")).toEqual([]);
    expect(getRunJobs("linkedin", "scraped", "profile-a")).toHaveLength(1);
  });

  it("resetAll drops every page and returns to the unscoped store", () => {
    setRunCaptureScope("profile-a");
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);
    resetAllRunJobCaptures();
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);

    expect(getRunJobs("linkedin", "scraped", "profile-a")).toEqual([]);
    expect(getRunJobs("linkedin", "scraped")).toHaveLength(1);
  });

  it("toCapturedRunJob copies the user-relevant fields", () => {
    const captured = toCapturedRunJob(
      makeInput({
        location: "Berlin",
        salary: "100k",
        jobType: "full-time",
        jobLevel: "senior",
        datePosted: "2026-05-01",
      }),
    );
    expect(captured).toMatchObject({
      title: "Engineer",
      employer: "Acme",
      location: "Berlin",
      salary: "100k",
      jobType: "full-time",
      jobLevel: "senior",
      datePosted: "2026-05-01",
    });
  });
});

describe("run-job-capture partitions manual and scheduled runs", () => {
  beforeEach(resetEveryPartition);
  afterEach(resetEveryPartition);

  it("keeps the same source's captures apart per partition", () => {
    captureRunJobs("linkedin", "scraped", [
      toCapturedRunJob(makeInput({ jobUrl: "manual-1" })),
    ]);
    setRunCaptureTrigger("schedule");
    captureRunJobs("linkedin", "scraped", [
      toCapturedRunJob(makeInput({ jobUrl: "scheduled-1" })),
      toCapturedRunJob(makeInput({ jobUrl: "scheduled-2" })),
    ]);

    expect(
      getRunJobs("linkedin", "scraped", "", "manual").map((job) => job.jobUrl),
    ).toEqual(["manual-1"]);
    expect(getRunJobs("linkedin", "scraped", "", "schedule")).toHaveLength(2);
    // The default is the unscoped MANUAL store, never whatever is running: a
    // click arrives long after the capture.
    expect(getRunJobs("linkedin", "scraped")).toHaveLength(1);
  });

  it("does not let a new run in one partition clear the other's captures", () => {
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);
    // A page of a chain, too — the sweep matches on a prefix, so a page-scoped
    // key of the other partition must survive it just as the unscoped one does.
    setRunCaptureScope("profile-a");
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);
    setRunCaptureScope("");

    // A scheduled run starting resets ITS captures — the manual table is still
    // on screen, and its counts have to keep opening the jobs behind them.
    setRunCaptureTrigger("schedule");
    resetAllRunJobCaptures();

    expect(getRunJobs("linkedin", "scraped", "", "manual")).toHaveLength(1);
    expect(
      getRunJobs("linkedin", "scraped", "profile-a", "manual"),
    ).toHaveLength(1);
  });

  it("writes to its own partition after a chain in the other one ended", () => {
    // A chain ends by pointing the scope back at the unscoped store; the next
    // run of the other kind must not inherit that partition.
    setRunCaptureTrigger("schedule");
    setRunCaptureScope("profile-a");
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);
    setRunCaptureScope("");

    setRunCaptureTrigger("manual");
    captureRunJobs("linkedin", "scraped", [
      toCapturedRunJob(makeInput({ jobUrl: "manual-1" })),
    ]);

    expect(
      getRunJobs("linkedin", "scraped", "", "manual").map((job) => job.jobUrl),
    ).toEqual(["manual-1"]);
    expect(
      getRunJobs("linkedin", "scraped", "profile-a", "schedule"),
    ).toHaveLength(1);
  });

  it("keeps a page aimed at by a re-run when the run establishes its trigger", () => {
    // The scenario this exists for: a scheduled run went last, so the capture
    // trigger is "schedule" when the route aims a manual re-run at a page.
    // `targetProfileRunPage` sets the profile BEFORE the run sets the trigger,
    // so establishing the trigger must not throw that aim away.
    setRunCaptureTrigger("schedule");
    setRunCaptureScope("profile-a");
    setRunCaptureTrigger("manual");
    captureRunJobs("linkedin", "scraped", [toCapturedRunJob(makeInput())]);

    expect(
      getRunJobs("linkedin", "scraped", "profile-a", "manual"),
    ).toHaveLength(1);
    expect(getRunJobs("linkedin", "scraped", "profile-a", "schedule")).toEqual(
      [],
    );
  });
});
