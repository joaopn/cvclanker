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
