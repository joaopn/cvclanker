import { createJob } from "@shared/testing/factories.js";
import type { Job } from "@shared/types.js";
import { describe, expect, it } from "vitest";
import { applySwipeSort } from "./swipeSort";

// The posting id is what makes a row read as LinkedIn to the client, so the
// fixtures carry a real numeric one — a slug the board never writes would
// silently sink every row to the non-LinkedIn floor.
const linkedin = (
  id: string,
  postingId: string,
  overrides: Partial<Job> = {},
): Job =>
  createJob({
    id,
    jobUrl: `https://www.linkedin.com/jobs/view/${postingId}`,
    liveStatusCheckedAt: "2026-08-24T10:00:00.000Z",
    datePosted: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });

const twelve = linkedin("li-12", "4000000012", {
  liveClosed: false,
  liveApplicants: "12 applicants",
});
const three = linkedin("li-3", "4000000003", {
  liveClosed: false,
  liveApplicants: "3 applicants",
});
const unchecked = linkedin("li-unchecked", "4000000099", {
  liveClosed: null,
  liveApplicants: null,
  liveStatusCheckedAt: null,
  datePosted: "2026-08-10T00:00:00.000Z",
});
const indeed = createJob({
  id: "indeed-1",
  source: "indeed",
  jobUrl: "https://www.indeed.com/viewjob?jk=abc123",
  datePosted: "2026-08-20T00:00:00.000Z",
});

const ids = (jobs: Job[]) => jobs.map((job) => job.id);

describe("applySwipeSort", () => {
  it("leaves the deck exactly as the hook ordered it when the sorter is None", () => {
    const deck = [twelve, three, indeed];
    expect(applySwipeSort(deck, "none")).toBe(deck);
  });

  it("puts the fewest applicants first, with the count-less rows below and non-LinkedIn last", () => {
    expect(
      ids(applySwipeSort([indeed, twelve, unchecked, three], "applicants")),
    ).toEqual(["li-3", "li-12", "li-unchecked", "indeed-1"]);
  });

  it("puts the newest posted first under the posted sorter", () => {
    expect(ids(applySwipeSort([three, indeed, unchecked], "posted"))).toEqual([
      "indeed-1",
      "li-unchecked",
      "li-3",
    ]);
  });

  it("never reorders the array it was handed", () => {
    const deck = [indeed, twelve, three];
    const before = ids(deck);
    applySwipeSort(deck, "applicants");
    expect(ids(deck)).toEqual(before);
  });
});
