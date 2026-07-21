import { describe, expect, it } from "vitest";
import {
  buildFacetPredicates,
  FACET_DEFS,
  type FacetJob,
  facetRequiresFullView,
} from "./registry";

// Partial job literals cast to FacetJob — predicates only read the one field
// their facet declares, so a full fixture is unnecessary.
const asJob = (fields: Record<string, unknown>): FacetJob =>
  fields as unknown as FacetJob;

const predicateFor = (id: string, value: string) =>
  buildFacetPredicates([{ id, value }])[0];

describe("facet registry", () => {
  it("exposes the Tier-1 facets without needing the full payload", () => {
    const tier1 = FACET_DEFS.filter((def) => !def.requiresFullView);
    expect(tier1.map((def) => def.id)).toEqual([
      "employer",
      "title",
      "location",
    ]);
    expect(
      facetRequiresFullView([
        { id: "employer", value: "x" },
        { id: "title", value: "y" },
      ]),
    ).toBe(false);
  });

  it("matches case-insensitively on a substring", () => {
    const predicate = predicateFor("employer", "acme");
    expect(predicate(asJob({ employer: "Acme Corp" }))).toBe(true);
    expect(predicate(asJob({ employer: "ACME" }))).toBe(true);
    expect(predicate(asJob({ employer: "Globex" }))).toBe(false);
  });

  it("treats `|` as OR'd terms", () => {
    const predicate = predicateFor("title", "senior|staff");
    expect(predicate(asJob({ title: "Senior Engineer" }))).toBe(true);
    expect(predicate(asJob({ title: "Staff Engineer" }))).toBe(true);
    expect(predicate(asJob({ title: "Junior Engineer" }))).toBe(false);
  });

  it("excludes rows whose field is loaded-but-empty (null)", () => {
    const predicate = predicateFor("location", "berlin");
    expect(predicate(asJob({ location: null }))).toBe(false);
    expect(predicate(asJob({ location: "Berlin, DE" }))).toBe(true);
  });

  it("stays inert on a wholly-absent field (list row before full upgrade)", () => {
    // The Tier-2 contract: a field missing from the object (undefined) must not
    // filter anything, so the list doesn't flash empty while view:"full" loads.
    const predicate = predicateFor("location", "berlin");
    expect(predicate(asJob({}))).toBe(true);
  });

  it("skips blank values and unknown facet ids", () => {
    expect(buildFacetPredicates([{ id: "employer", value: "   " }])).toEqual(
      [],
    );
    expect(buildFacetPredicates([{ id: "nope", value: "x" }])).toEqual([]);
    expect(
      buildFacetPredicates([{ id: "employer", value: "acme" }]),
    ).toHaveLength(1);
  });
});

describe("facet registry — Tier-2 (full payload)", () => {
  it("marks the Tier-2 facets as needing the full view", () => {
    for (const id of ["description", "degreeRequired", "jobLevel", "remote"]) {
      expect(facetRequiresFullView([{ id, value: "x" }])).toBe(true);
    }
    // A mix still needs the full payload.
    expect(
      facetRequiresFullView([
        { id: "employer", value: "acme" },
        { id: "description", value: "phd" },
      ]),
    ).toBe(true);
  });

  it("matches a full-only text field and stays inert on a list row", () => {
    const predicate = predicateFor("description", "phd|doctorate");
    expect(predicate(asJob({ jobDescription: "PhD required" }))).toBe(true);
    expect(predicate(asJob({ jobDescription: "Doctorate preferred" }))).toBe(
      true,
    );
    expect(predicate(asJob({ jobDescription: "No degree needed" }))).toBe(
      false,
    );
    expect(predicate(asJob({ jobDescription: null }))).toBe(false);
    expect(predicate(asJob({}))).toBe(true); // list row before full upgrade
  });

  it("matches remote across workFromHomeType and the isRemote boolean", () => {
    const predicate = predicateFor("remote", "remote|hybrid");
    expect(predicate(asJob({ workFromHomeType: "hybrid" }))).toBe(true);
    expect(predicate(asJob({ workFromHomeType: null, isRemote: true }))).toBe(
      true,
    );
    expect(
      predicate(asJob({ workFromHomeType: "onsite", isRemote: false })),
    ).toBe(false);
    expect(predicate(asJob({}))).toBe(true); // both fields absent ⇒ inert
  });
});
