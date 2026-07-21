import { createJob } from "@shared/testing/factories.js";
import type { JobListItem } from "@shared/types";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATE_FILTER, DEFAULT_SORT, type FilterTab } from "./constants";
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

describe("useFilteredJobs untailored toggle scope (B2a)", () => {
  const mixed: JobListItem[] = [
    createJob({ id: "disc", status: "discovered", employer: "A", title: "T" }),
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

  it("does not empty Live/Interviewing when the untailored toggle is stuck on", () => {
    // Untailored is a tailoring/all-only control; on a tab that doesn't render
    // the chip it must be IGNORED, not applied globally (which first narrowed
    // to {discovered,backlog,stale}, so Live→applied and Interviewing→
    // in_progress both came out empty with no way to unset it).
    expect(ids(runTab("live", true))).toEqual(["app"]);
    expect(ids(runTab("interviewing", true))).toEqual(["prog"]);
  });

  it("still narrows to untailored candidates on its own tabs (Tailoring, All)", () => {
    expect(ids(runTab("tailoring", true))).toEqual(["disc"]);
    expect(ids(runTab("all", true))).toEqual(["disc"]);
  });
});
