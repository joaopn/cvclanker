import { describe, expect, it } from "vitest";
import {
  createDefaultSearchState,
  resolveSortBy,
} from "../src/default-search-state";

describe("resolveSortBy", () => {
  it("asks for newest-first when a max job age is configured", () => {
    expect(resolveSortBy(7)).toBe("date");
    expect(resolveSortBy(1)).toBe("date");
    expect(resolveSortBy(365)).toBe("date");
  });

  it("keeps relevance ranking when no max job age is configured", () => {
    expect(resolveSortBy(0)).toBe("default");
    expect(resolveSortBy(null)).toBe("default");
    expect(resolveSortBy(undefined)).toBe("default");
    expect(resolveSortBy(Number.NaN)).toBe("default");
  });
});

describe("createDefaultSearchState", () => {
  it("sends the resolved sort and window in the search state", () => {
    const state = createDefaultSearchState({
      searchQuery: "software engineer",
      location: null,
      dateFetchedPastNDays: 7,
      sortBy: resolveSortBy(7),
    });

    expect(state.sortBy).toBe("date");
    expect(state.dateFetchedPastNDays).toBe(7);
    expect(state.searchQuery).toBe("software engineer");
  });

  it("leaves the sort alone for an unconfigured window", () => {
    const state = createDefaultSearchState({
      searchQuery: "software engineer",
      location: null,
      dateFetchedPastNDays: 30,
      sortBy: resolveSortBy(0),
    });

    expect(state.sortBy).toBe("default");
  });
});
