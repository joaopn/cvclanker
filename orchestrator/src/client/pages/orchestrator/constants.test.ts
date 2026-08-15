import { describe, expect, it } from "vitest";
import type { FilterTab, JobFilterChipType } from "./constants";
import { filterChipTypesForTab, isFilterFamilyActive, tabs } from "./constants";

// Written out per tab rather than derived from FIT_CHIP_TABS / FILTER_BAR_TABS:
// re-deriving from the same constants the implementation filters on would pass
// no matter how those lists were edited. Closed is the one tab that renders no
// filter bar at all; every tab that renders one now offers all three families.
const EXPECTED: Array<[FilterTab, JobFilterChipType[]]> = [
  ["inbox", ["fit", "profile", "title"]],
  ["tailoring", ["fit", "profile", "title"]],
  ["live", ["fit", "profile", "title"]],
  ["interviewing", ["fit", "profile", "title"]],
  ["backlog", ["fit", "profile", "title"]],
  ["stale", ["fit", "profile", "title"]],
  ["all", ["fit", "profile", "title"]],
  ["closed", []],
];

describe("filterChipTypesForTab", () => {
  it.each(EXPECTED)("offers the right families on %s", (tab, expected) => {
    expect(filterChipTypesForTab(tab)).toEqual(expected);
  });

  it("covers every tab the Manage view can show", () => {
    expect(EXPECTED.map(([tab]) => tab).sort()).toEqual(
      tabs.map((tab) => tab.id).sort(),
    );
  });
});

describe("isFilterFamilyActive", () => {
  it("requires the family to be both offered by the tab and ticked", () => {
    expect(isFilterFamilyActive(["fit", "profile"], ["fit"], "fit")).toBe(true);
    // Ticked but not offered here — this is the case that must NOT narrow.
    expect(isFilterFamilyActive(["profile"], ["fit", "profile"], "fit")).toBe(
      false,
    );
    // Offered but not ticked.
    expect(isFilterFamilyActive(["fit", "profile"], ["fit"], "profile")).toBe(
      false,
    );
  });
});
