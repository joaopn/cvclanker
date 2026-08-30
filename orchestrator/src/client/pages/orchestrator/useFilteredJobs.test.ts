import { createJob } from "@shared/testing/factories.js";
import type { JobListItem } from "@shared/types";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATE_FILTER,
  DEFAULT_SORT,
  type FilterTab,
  UNATTRIBUTED_PROFILE_ID,
} from "./constants";
import type { ActiveFacet } from "./facets/registry";
import { useFilteredJobs } from "./useFilteredJobs";

const jobs: JobListItem[] = [
  createJob({
    id: "a",
    status: "discovered",
    employer: "Acme Corp",
    title: "Senior Engineer",
    location: "Berlin, DE",
  }),
  createJob({
    id: "b",
    status: "discovered",
    employer: "Globex",
    title: "Junior Engineer",
    location: "Vienna, AT",
  }),
];

const run = (activeFacets: ActiveFacet[]) =>
  renderHook(() =>
    useFilteredJobs(
      jobs,
      "all",
      DEFAULT_DATE_FILTER,
      "all",
      { mode: "at_least", min: null, max: null },
      DEFAULT_SORT,
      null,
      "all",
      [],
      false,
      activeFacets,
    ),
  ).result.current;

const ids = (list: JobListItem[]) => list.map((job) => job.id).sort();

describe("useFilteredJobs facet filtering", () => {
  it("returns every job when no facets are active", () => {
    expect(ids(run([]))).toEqual(["a", "b"]);
  });

  it("narrows to rows matching an active facet", () => {
    expect(ids(run([{ id: "employer", value: "acme" }]))).toEqual(["a"]);
    expect(ids(run([{ id: "title", value: "junior" }]))).toEqual(["b"]);
  });

  it("does not narrow on a blank facet value", () => {
    expect(ids(run([{ id: "employer", value: "  " }]))).toEqual(["a", "b"]);
  });

  it("ANDs multiple active facets", () => {
    expect(
      ids(
        run([
          { id: "title", value: "engineer" },
          { id: "location", value: "berlin" },
        ]),
      ),
    ).toEqual(["a"]);
  });
});

describe("useFilteredJobs profile and job-title badges", () => {
  const attributed: JobListItem[] = [
    createJob({
      id: "p1-data",
      status: "discovered",
      profileId: "p1",
      title: "Senior Data Engineer",
    }),
    createJob({
      id: "p2-platform",
      status: "discovered",
      profileId: "p2",
      title: "Platform Engineer",
    }),
    createJob({
      id: "none",
      status: "discovered",
      profileId: null,
      title: "Data Engineer",
    }),
  ];

  const runChips = (
    profileFilter: string[],
    titleFilter: string[],
    knownProfileIds: string[] = ["p1", "p2"],
  ) =>
    renderHook(() =>
      useFilteredJobs(
        attributed,
        "all",
        DEFAULT_DATE_FILTER,
        "all",
        { mode: "at_least", min: null, max: null },
        DEFAULT_SORT,
        null,
        "all",
        [],
        false,
        [],
        profileFilter,
        titleFilter,
        knownProfileIds,
      ),
    ).result.current;

  it("does not narrow when nothing is picked", () => {
    expect(ids(runChips([], []))).toEqual(["none", "p1-data", "p2-platform"]);
  });

  it("ORs the picked profiles and excludes unattributed rows", () => {
    expect(ids(runChips(["p1"], []))).toEqual(["p1-data"]);
    expect(ids(runChips(["p1", "p2"], []))).toEqual(["p1-data", "p2-platform"]);
  });

  it("reaches unattributed rows only through the sentinel", () => {
    expect(ids(runChips([UNATTRIBUTED_PROFILE_ID], []))).toEqual(["none"]);
    expect(ids(runChips([UNATTRIBUTED_PROFILE_ID, "p2"], []))).toEqual([
      "none",
      "p2-platform",
    ]);
  });

  it("treats a row from a deleted profile as unattributed", () => {
    // p1 is gone: its rows match no badge, so the sentinel has to own them or
    // they are reachable from no profile selection at all.
    expect(ids(runChips(["p2"], [], ["p2"]))).toEqual(["p2-platform"]);
    expect(ids(runChips([UNATTRIBUTED_PROFILE_ID], [], ["p2"]))).toEqual([
      "none",
      "p1-data",
    ]);
  });

  it("substring-matches job titles case-insensitively, OR'd", () => {
    expect(ids(runChips([], ["data engineer"]))).toEqual(["none", "p1-data"]);
    expect(ids(runChips([], ["platform", "senior data"]))).toEqual([
      "p1-data",
      "p2-platform",
    ]);
  });

  it("ANDs the two families together", () => {
    expect(ids(runChips(["p1"], ["platform"]))).toEqual([]);
    expect(ids(runChips(["p1", "p2"], ["engineer"]))).toEqual([
      "p1-data",
      "p2-platform",
    ]);
  });

  it("ignores a blank title term rather than matching everything", () => {
    expect(ids(runChips([], ["   "]))).toEqual([
      "none",
      "p1-data",
      "p2-platform",
    ]);
  });
});

describe("useFilteredJobs untailored toggle (Tailoring-only within-tab filter)", () => {
  const mixed: JobListItem[] = [
    createJob({ id: "disc", status: "discovered", employer: "A", title: "T" }),
    createJob({ id: "proc", status: "processing", employer: "A", title: "T" }),
    createJob({ id: "rdy", status: "ready", employer: "A", title: "T" }),
    createJob({ id: "app", status: "applied", employer: "A", title: "T" }),
    createJob({ id: "prog", status: "in_progress", employer: "A", title: "T" }),
  ];
  const runTab = (activeTab: FilterTab, untailoredOnly: boolean) =>
    renderHook(() =>
      useFilteredJobs(
        mixed,
        activeTab,
        DEFAULT_DATE_FILTER,
        "all",
        { mode: "at_least", min: null, max: null },
        DEFAULT_SORT,
        null,
        "all",
        [],
        untailoredOnly,
        [],
      ),
    ).result.current;

  it("narrows the Tailoring tab to the not-yet-tailored (processing) rows when on", () => {
    // Off: the whole funnel (processing + ready). On: only processing (which
    // includes failed tailors awaiting retry).
    expect(ids(runTab("tailoring", false))).toEqual(["proc", "rdy"]);
    expect(ids(runTab("tailoring", true))).toEqual(["proc"]);
  });

  it("is inert on every other tab — it is Tailoring-only now", () => {
    expect(ids(runTab("live", true))).toEqual(["app"]);
    expect(ids(runTab("interviewing", true))).toEqual(["prog"]);
    // On All the toggle no longer narrows: same set with it on or off.
    expect(ids(runTab("all", true))).toEqual(ids(runTab("all", false)));
  });
});

describe("useFilteredJobs sorter", () => {
  // Under the popover's score sort `high` leads; under posted / found `old`
  // (posted latest) leads; under fewer applicants `few` leads and the
  // non-LinkedIn `high` row drops to the floor.
  const rows: JobListItem[] = [
    createJob({
      id: "high",
      status: "discovered",
      source: "indeed",
      jobUrl: "https://www.indeed.com/viewjob?jk=high",
      suitabilityCategory: "great_fit",
      datePosted: "2026-08-10T00:00:00.000Z",
      employer: "A",
      title: "T",
    }),
    createJob({
      id: "old",
      status: "discovered",
      jobUrl: "https://www.linkedin.com/jobs/view/4000000001",
      suitabilityCategory: "bad_fit",
      datePosted: "2026-08-20T00:00:00.000Z",
      liveClosed: false,
      liveApplicants: "40 applicants",
      liveStatusCheckedAt: "2026-08-24T00:00:00.000Z",
      employer: "A",
      title: "T",
    }),
    createJob({
      id: "few",
      status: "discovered",
      jobUrl: "https://www.linkedin.com/jobs/view/4000000002",
      suitabilityCategory: "good_fit",
      datePosted: "2026-08-01T00:00:00.000Z",
      liveClosed: false,
      liveApplicants: "2 applicants",
      liveStatusCheckedAt: "2026-08-24T00:00:00.000Z",
      employer: "A",
      title: "T",
    }),
  ];
  const runSorter = (sorter: "none" | "posted" | "applicants") =>
    renderHook(() =>
      useFilteredJobs(
        rows,
        "inbox",
        DEFAULT_DATE_FILTER,
        "all",
        { mode: "at_least", min: null, max: null },
        { key: "score", direction: "desc" },
        null,
        "all",
        [],
        false,
        [],
        [],
        [],
        [],
        sorter,
      ),
    ).result.current.map((job) => job.id);

  it("leaves the popover sort in charge while idle", () => {
    expect(runSorter("none")).toEqual(["high", "few", "old"]);
  });

  it("overrides the popover sort with posted / found", () => {
    expect(runSorter("posted")).toEqual(["old", "high", "few"]);
  });

  it("overrides the popover sort with fewer applicants, non-LinkedIn last", () => {
    expect(runSorter("applicants")).toEqual(["few", "old", "high"]);
  });
});

/**
 * The permanent applied mark. `appliedAt` is stamped once by the server on the
 * first move to Applied/Interviewing and never cleared, so it stays true for a
 * closed row — which is the point: it separates a real rejection from a job
 * that was never applied to.
 */
describe("useFilteredJobs applied filter", () => {
  const closedJobs: JobListItem[] = [
    createJob({
      id: "was-applied",
      status: "closed",
      outcome: "rejected",
      appliedAt: "2026-05-01T09:00:00.000Z",
    }),
    createJob({
      id: "never-applied",
      status: "skipped",
      appliedAt: null,
    }),
    createJob({
      id: "closed-never-applied",
      status: "closed",
      outcome: "duplicated",
      appliedAt: null,
    }),
  ];

  const runApplied = (appliedFilter: "all" | "applied" | "not_applied") =>
    renderHook(() =>
      useFilteredJobs(
        closedJobs,
        "closed",
        DEFAULT_DATE_FILTER,
        "all",
        { mode: "at_least", min: null, max: null },
        DEFAULT_SORT,
        null,
        "all",
        [],
        false,
        [],
        [],
        [],
        [],
        "none",
        appliedFilter,
      ),
    ).result.current;

  it("is inert by default", () => {
    expect(ids(runApplied("all"))).toEqual([
      "closed-never-applied",
      "never-applied",
      "was-applied",
    ]);
  });

  it("keeps only rows carrying the applied mark", () => {
    expect(ids(runApplied("applied"))).toEqual(["was-applied"]);
  });

  it("keeps only rows that were never applied to", () => {
    expect(ids(runApplied("not_applied"))).toEqual([
      "closed-never-applied",
      "never-applied",
    ]);
  });
});
