import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFacetFilters } from "./useFacetFilters";

describe("useFacetFilters", () => {
  it("starts empty and needs no full payload", () => {
    const { result } = renderHook(() => useFacetFilters());
    expect(result.current.activeFacets).toEqual([]);
    expect(result.current.requiresFullView).toBe(false);
  });

  it("adds a facet once, ignoring duplicates and unknown ids", () => {
    const { result } = renderHook(() => useFacetFilters());

    act(() => result.current.addFacet("employer"));
    expect(result.current.activeFacets).toEqual([
      { id: "employer", value: "" },
    ]);

    act(() => result.current.addFacet("employer"));
    act(() => result.current.addFacet("does-not-exist"));
    expect(result.current.activeFacets).toEqual([
      { id: "employer", value: "" },
    ]);
  });

  it("sets, removes and clears facet values", () => {
    const { result } = renderHook(() => useFacetFilters());

    act(() => result.current.addFacet("employer"));
    act(() => result.current.addFacet("title"));
    act(() => result.current.setFacetValue("employer", "acme"));
    expect(result.current.activeFacets).toEqual([
      { id: "employer", value: "acme" },
      { id: "title", value: "" },
    ]);

    act(() => result.current.removeFacet("employer"));
    expect(result.current.activeFacets).toEqual([{ id: "title", value: "" }]);

    act(() => result.current.clearFacets());
    expect(result.current.activeFacets).toEqual([]);
  });
});
