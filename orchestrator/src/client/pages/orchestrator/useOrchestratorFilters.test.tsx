import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { DEFAULT_SORT } from "./constants";
import { useOrchestratorFilters } from "./useOrchestratorFilters";

const createWrapper = (initialEntry: string) => {
  let latestLocation = "";

  const LocationWatcher = () => {
    const location = useLocation();
    latestLocation = location.pathname + location.search;
    return null;
  };

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationWatcher />
      {children}
    </MemoryRouter>
  );
  Wrapper.displayName = "RouterWrapper";
  return { Wrapper, getLocation: () => latestLocation };
};

describe("useOrchestratorFilters", () => {
  it("parses a valid sort query param", () => {
    const { Wrapper } = createWrapper("/ready?sort=date-asc");
    const { result } = renderHook(() => useOrchestratorFilters(), {
      wrapper: Wrapper,
    });

    expect(result.current.sort).toEqual({
      key: "date",
      direction: "asc",
    });
  });

  it("parses the applicants sort key", () => {
    const { Wrapper } = createWrapper("/jobs/inbox?sort=applicants-desc");
    const { result } = renderHook(() => useOrchestratorFilters(), {
      wrapper: Wrapper,
    });

    expect(result.current.sort).toEqual({
      key: "applicants",
      direction: "desc",
    });
  });

  it("falls back to default sort for invalid sort query params", () => {
    const cases = [
      "/ready?sort=title",
      "/ready?sort=invalid-asc",
      "/ready?sort=title-sideways",
    ];

    for (const entry of cases) {
      const { Wrapper } = createWrapper(entry);
      const { result } = renderHook(() => useOrchestratorFilters(), {
        wrapper: Wrapper,
      });
      expect(result.current.sort).toEqual(DEFAULT_SORT);
    }
  });

  it("parses date filter params", () => {
    const { Wrapper } = createWrapper(
      "/all?date=ready,applied&appliedRange=30&appliedStart=2026-03-10&appliedEnd=2026-04-08",
    );
    const { result } = renderHook(() => useOrchestratorFilters(), {
      wrapper: Wrapper,
    });

    expect(result.current.dateFilter).toEqual({
      dimensions: ["ready", "applied"],
      startDate: "2026-03-10",
      endDate: "2026-04-08",
      preset: "30",
    });
  });

  it("round-trips date filter params and resets them", () => {
    const { Wrapper, getLocation } = createWrapper("/all");
    const { result } = renderHook(() => useOrchestratorFilters(), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.setDateFilter({
        dimensions: ["ready", "closed"],
        startDate: "2026-04-01",
        endDate: "2026-04-08",
        preset: "custom",
      });
    });

    expect(getLocation()).toContain("date=ready%2Cclosed");
    expect(getLocation()).toContain("appliedStart=2026-04-01");
    expect(getLocation()).toContain("appliedEnd=2026-04-08");
    expect(getLocation()).toContain("appliedRange=custom");

    act(() => {
      result.current.resetFilters();
    });

    expect(getLocation()).toBe("/all");
  });

  it("parses the sorter param and ignores an unknown value", () => {
    const valid = createWrapper("/jobs/inbox?sorter=applicants");
    expect(
      renderHook(() => useOrchestratorFilters(), { wrapper: valid.Wrapper })
        .result.current.sorter,
    ).toBe("applicants");

    const invalid = createWrapper("/jobs/inbox?sorter=salary");
    expect(
      renderHook(() => useOrchestratorFilters(), { wrapper: invalid.Wrapper })
        .result.current.sorter,
    ).toBe("none");

    const absent = createWrapper("/jobs/inbox");
    expect(
      renderHook(() => useOrchestratorFilters(), { wrapper: absent.Wrapper })
        .result.current.sorter,
    ).toBe("none");
  });

  it("writes the sorter to the URL, drops it on none, and clears it on reset", () => {
    const { Wrapper, getLocation } = createWrapper(
      "/jobs/inbox?sort=score-desc",
    );
    const { result } = renderHook(() => useOrchestratorFilters(), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.setSorter("posted");
    });
    expect(result.current.sorter).toBe("posted");
    expect(getLocation()).toContain("sorter=posted");
    // The popover's sort is untouched — the sorter is a layer over it.
    expect(getLocation()).toContain("sort=score-desc");

    act(() => {
      result.current.setSorter("none");
    });
    expect(getLocation()).not.toContain("sorter=");

    act(() => {
      result.current.setSorter("applicants");
    });
    act(() => {
      result.current.resetFilters();
    });
    expect(result.current.sorter).toBe("none");
    expect(getLocation()).not.toContain("sorter=");
    expect(getLocation()).not.toContain("sort=");
  });

  /**
   * The permanent applied mark's filter. Note the param name: `appliedStart` /
   * `appliedEnd` / `appliedRange` already exist and mean the applied DATE
   * range, so this one is `appliedEver` to avoid reading as a fourth member of
   * that family.
   */
  it("parses appliedEver and ignores an unknown value", () => {
    for (const [entry, expected] of [
      ["/jobs/closed?appliedEver=applied", "applied"],
      ["/jobs/closed?appliedEver=not_applied", "not_applied"],
      ["/jobs/closed?appliedEver=nonsense", "all"],
      ["/jobs/closed", "all"],
    ] as const) {
      const { Wrapper } = createWrapper(entry);
      const { result } = renderHook(() => useOrchestratorFilters(), {
        wrapper: Wrapper,
      });
      expect(result.current.appliedFilter).toBe(expected);
    }
  });

  it("writes appliedEver to the URL, drops it on all, and clears it on reset", () => {
    const { Wrapper, getLocation } = createWrapper("/jobs/closed");
    const { result } = renderHook(() => useOrchestratorFilters(), {
      wrapper: Wrapper,
    });

    act(() => {
      result.current.setAppliedFilter("applied");
    });
    expect(getLocation()).toContain("appliedEver=applied");

    act(() => {
      result.current.setAppliedFilter("all");
    });
    expect(getLocation()).not.toContain("appliedEver");

    act(() => {
      result.current.setAppliedFilter("not_applied");
    });
    expect(getLocation()).toContain("appliedEver=not_applied");

    // Reset must clear it, or the filter keeps narrowing after the user has
    // explicitly cleared their filters.
    act(() => {
      result.current.resetFilters();
    });
    expect(getLocation()).not.toContain("appliedEver");
  });
});
