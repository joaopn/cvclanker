import { createJob } from "@shared/testing/factories.js";
import type { JobListItem } from "@shared/types";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_DATE_FILTER, DEFAULT_SORT } from "./constants";
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
