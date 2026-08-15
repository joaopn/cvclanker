import type { CreateJobInput } from "@shared/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  captureRunJobs,
  getRunJobs,
  resetAllRunJobCaptures,
  resetRunJobCapture,
  resetRunJobCaptureForSource,
  setRunCaptureScope,
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

describe("run-job-capture", () => {
  beforeEach(() => {
    resetAllRunJobCaptures();
  });

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
