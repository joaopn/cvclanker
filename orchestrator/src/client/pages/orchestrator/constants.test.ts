import { describe, expect, it } from "vitest";
import type { FilterTab, JobFilterChipType } from "./constants";
import {
  filterChipTypesForTab,
  isFilterFamilyActive,
  showsEasyApplyChip,
  tabs,
} from "./constants";

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

// The Easy-Apply chip rule. Both render sites call this from inside JSX that
// already guarantees "checked" and "not closed", so those two clauses decide
// nothing THERE — these tests are what keeps them real for any third caller,
// and what stops them rotting into decoration.
describe("showsEasyApplyChip", () => {
  const checked = "2026-09-03T10:00:00.000Z";

  it("flags a checked, open, on-LinkedIn posting", () => {
    expect(
      showsEasyApplyChip({
        liveStatusCheckedAt: checked,
        liveClosed: false,
        liveEasyApply: true,
      }),
    ).toBe(true);
  });

  it("refuses a row nobody has checked, whatever the column says", () => {
    // A stored verdict with no timestamp is stale bookkeeping, not evidence.
    expect(
      showsEasyApplyChip({
        liveStatusCheckedAt: null,
        liveClosed: false,
        liveEasyApply: true,
      }),
    ).toBe(false);
  });

  it("refuses a closed posting even if a verdict is stored", () => {
    // A closed posting renders no Apply button, so any surviving `true` is a
    // pre-closure verdict and presenting it would claim a route to apply that
    // no longer exists.
    expect(
      showsEasyApplyChip({
        liveStatusCheckedAt: checked,
        liveClosed: true,
        liveEasyApply: true,
      }),
    ).toBe(false);
  });

  it("refuses offsite and unknown, which are different things", () => {
    // `false` is a verdict ("apply on the employer's site"), `null` is "not
    // known" — neither earns a chip, but they must not be conflated.
    for (const liveEasyApply of [false, null]) {
      expect(
        showsEasyApplyChip({
          liveStatusCheckedAt: checked,
          liveClosed: false,
          liveEasyApply,
        }),
      ).toBe(false);
    }
  });
});
