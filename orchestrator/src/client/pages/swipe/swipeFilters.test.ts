import { createJob } from "@shared/testing/factories.js";
import type { Job } from "@shared/types.js";
import { describe, expect, it } from "vitest";
import { UNATTRIBUTED_PROFILE_ID } from "../orchestrator/constants";
import {
  applySwipeFilters,
  EMPTY_SWIPE_FILTERS,
  effectiveSwipeFilters,
  hasActiveSwipeFilters,
} from "./swipeFilters";

const job = (overrides: Partial<Job>): Job =>
  createJob({ status: "discovered", ...overrides });

const ids = (jobs: Job[]) => jobs.map((entry) => entry.id);

describe("hasActiveSwipeFilters", () => {
  it("is false only when every family is empty", () => {
    expect(hasActiveSwipeFilters(EMPTY_SWIPE_FILTERS)).toBe(false);
    expect(
      hasActiveSwipeFilters({ fit: ["unscored"], profile: [], title: [] }),
    ).toBe(true);
    expect(hasActiveSwipeFilters({ fit: [], profile: ["p1"], title: [] })).toBe(
      true,
    );
    expect(
      hasActiveSwipeFilters({ fit: [], profile: [], title: ["python"] }),
    ).toBe(true);
  });
});

describe("applySwipeFilters", () => {
  const jobs = [
    job({
      id: "a",
      title: "Senior Python Engineer",
      suitabilityCategory: "great_fit",
      profileId: "p1",
    }),
    job({
      id: "b",
      title: "Go Developer",
      suitabilityCategory: "bad_fit",
      profileId: "p2",
    }),
    job({
      id: "c",
      title: "python analyst",
      suitabilityCategory: null,
      profileId: null,
    }),
    job({
      id: "d",
      title: "Rust Engineer",
      suitabilityCategory: "good_fit",
      profileId: "deleted-profile",
    }),
  ];
  const known = ["p1", "p2"];
  const titles = ["Python", "Go"];

  it("returns everything untouched with no filters", () => {
    expect(applySwipeFilters(jobs, EMPTY_SWIPE_FILTERS, known, titles)).toBe(
      jobs,
    );
  });

  it("narrows by fit, with unscored matching a null category", () => {
    expect(
      ids(
        applySwipeFilters(
          jobs,
          { fit: ["great_fit", "unscored"], profile: [], title: [] },
          known,
          titles,
        ),
      ),
    ).toEqual(["a", "c"]);
  });

  it("narrows by profile, with the sentinel matching null and deleted attributions", () => {
    expect(
      ids(
        applySwipeFilters(
          jobs,
          { fit: [], profile: ["p1"], title: [] },
          known,
          titles,
        ),
      ),
    ).toEqual(["a"]);
    expect(
      ids(
        applySwipeFilters(
          jobs,
          { fit: [], profile: [UNATTRIBUTED_PROFILE_ID], title: [] },
          known,
          titles,
        ),
      ),
    ).toEqual(["c", "d"]);
  });

  it("narrows by job title as a case-insensitive substring", () => {
    expect(
      ids(
        applySwipeFilters(
          jobs,
          { fit: [], profile: [], title: ["Python"] },
          known,
          titles,
        ),
      ),
    ).toEqual(["a", "c"]);
  });

  it("ANDs across families and ORs within one", () => {
    expect(
      ids(
        applySwipeFilters(
          jobs,
          {
            fit: ["great_fit", "bad_fit"],
            profile: ["p1", "p2"],
            title: ["Python"],
          },
          known,
          titles,
        ),
      ),
    ).toEqual(["a"]);
  });

  it("ignores picks whose badge is no longer offered", () => {
    // A deleted profile and an edited-away search term stop narrowing.
    expect(
      ids(
        applySwipeFilters(
          jobs,
          { fit: [], profile: ["gone"], title: ["removed term"] },
          known,
          titles,
        ),
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores profile picks entirely when no profiles exist", () => {
    expect(
      ids(
        applySwipeFilters(
          jobs,
          { fit: [], profile: [UNATTRIBUTED_PROFILE_ID], title: [] },
          [],
          titles,
        ),
      ),
    ).toEqual(["a", "b", "c", "d"]);
  });
});

describe("effectiveSwipeFilters", () => {
  it("drops stale picks so the active indicator can't claim filtering that no longer happens", () => {
    expect(
      effectiveSwipeFilters(
        { fit: ["great_fit"], profile: ["gone", "p1"], title: ["removed"] },
        ["p1"],
        [],
      ),
    ).toEqual({ fit: ["great_fit"], profile: ["p1"], title: [] });
    expect(
      hasActiveSwipeFilters(
        effectiveSwipeFilters(
          { fit: [], profile: ["gone"], title: ["removed"] },
          ["p1"],
          [],
        ),
      ),
    ).toBe(false);
  });

  it("keeps the sentinel only while at least one profile exists", () => {
    expect(
      effectiveSwipeFilters(
        { fit: [], profile: [UNATTRIBUTED_PROFILE_ID], title: [] },
        ["p1"],
        [],
      ).profile,
    ).toEqual([UNATTRIBUTED_PROFILE_ID]);
    expect(
      effectiveSwipeFilters(
        { fit: [], profile: [UNATTRIBUTED_PROFILE_ID], title: [] },
        [],
        [],
      ).profile,
    ).toEqual([]);
  });
});
