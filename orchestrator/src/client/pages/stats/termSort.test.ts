import type { StatsTermRow } from "@shared/types";
import { describe, expect, it } from "vitest";
import { nextTermSort, sortTerms } from "./termSort";

const row = (
  term: string,
  scored: number,
  goodFit = 0,
  applied = 0,
): StatsTermRow => ({ term, jobs: scored, scored, goodFit, applied });

const terms = (rows: StatsTermRow[]) => rows.map((r) => r.term);

describe("nextTermSort", () => {
  it("cycles ascending, descending, then back to the default", () => {
    const asc = nextTermSort(null, "fitRate");
    expect(asc).toEqual({ key: "fitRate", direction: "asc" });
    const desc = nextTermSort(asc, "fitRate");
    expect(desc).toEqual({ key: "fitRate", direction: "desc" });
    expect(nextTermSort(desc, "fitRate")).toBeNull();
  });

  it("toggles the Term column between descending and the alphabetical default", () => {
    const desc = nextTermSort(null, "term");
    expect(desc).toEqual({ key: "term", direction: "desc" });
    expect(nextTermSort(desc, "term")).toBeNull();
    expect(nextTermSort({ key: "scored", direction: "asc" }, "term")).toEqual(
      desc,
    );
  });

  it("starts ascending when switching to another column", () => {
    expect(
      nextTermSort({ key: "scored", direction: "desc" }, "applied"),
    ).toEqual({ key: "applied", direction: "asc" });
  });
});

describe("sortTerms", () => {
  const rows = [
    row("beta", 10, 5, 1),
    row("Alpha", 4, 4, 2),
    row("gamma", 0),
    row("Delta", 10, 1, 0),
  ];

  it("defaults to alphabetical by locale, without touching the input", () => {
    // Code-unit order would put "Delta" before "beta".
    const before = [...rows];
    expect(terms(sortTerms(rows, null))).toEqual([
      "Alpha",
      "beta",
      "Delta",
      "gamma",
    ]);
    expect(rows).toEqual(before);
  });

  it("sorts a count both ways, breaking ties alphabetically", () => {
    expect(terms(sortTerms(rows, { key: "scored", direction: "asc" }))).toEqual(
      ["gamma", "Alpha", "beta", "Delta"],
    );
    expect(
      terms(sortTerms(rows, { key: "scored", direction: "desc" })),
    ).toEqual(["beta", "Delta", "Alpha", "gamma"]);
  });

  it("sorts the good-fit and applied counts", () => {
    expect(
      terms(sortTerms(rows, { key: "goodFit", direction: "desc" })),
    ).toEqual(["beta", "Alpha", "Delta", "gamma"]);
    expect(
      terms(sortTerms(rows, { key: "applied", direction: "desc" })),
    ).toEqual(["Alpha", "beta", "Delta", "gamma"]);
  });

  it("sorts a rate over scored jobs, with an unscored term last both ways", () => {
    // Fit rates: Alpha 100%, beta 50%, Delta 10%, gamma none.
    expect(
      terms(sortTerms(rows, { key: "fitRate", direction: "asc" })),
    ).toEqual(["Delta", "beta", "Alpha", "gamma"]);
    expect(
      terms(sortTerms(rows, { key: "fitRate", direction: "desc" })),
    ).toEqual(["Alpha", "beta", "Delta", "gamma"]);
    // Applied rates: Alpha 50%, beta 10%, Delta 0%, gamma none.
    expect(
      terms(sortTerms(rows, { key: "appliedRate", direction: "asc" })),
    ).toEqual(["Delta", "beta", "Alpha", "gamma"]);
  });

  it("sorts the term column both ways", () => {
    expect(terms(sortTerms(rows, { key: "term", direction: "desc" }))).toEqual([
      "gamma",
      "Delta",
      "beta",
      "Alpha",
    ]);
  });
});
