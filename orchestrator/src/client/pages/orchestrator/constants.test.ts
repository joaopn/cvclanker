import type { JobStatus } from "@shared/types";
import { describe, expect, it } from "vitest";
import type { FilterTab, JobFilterChipType } from "./constants";
import {
  filterChipTypesForTab,
  isFilterFamilyActive,
  showsAppliedBadge,
  showsAppliedDate,
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

/**
 * Which of the two applied surfaces a row gets. `showsAppliedDate` is written
 * as `isEverApplied` minus `showsAppliedBadge`, and its FIRST term is invisible
 * from `JobRowContent`: that caller re-checks the stamp with `dateValue`, so
 * dropping the term there changes nothing it renders. Asserted directly on the
 * predicate instead, which is what the exported contract actually promises.
 */
describe("the applied mark's two surfaces", () => {
  const marked = "2026-05-01T09:00:00.000Z";
  /**
   * `satisfies Record<JobStatus, true>` is what makes this exhaustive. An
   * annotation of `JobStatus[]` constrains the members and never the
   * cardinality, so a status added to the union and forgotten here would
   * type-check and go silently untested. (`pages/settings/constants.ts` keeps
   * its own `ALL_JOB_STATUSES` — the same ten strings in the same order, but
   * annotated `JobStatus[]` and therefore NOT exhaustiveness-checked. Not
   * imported here because it belongs to another page directory; the
   * `satisfies` protects this copy only.)
   */
  const ALL_STATUSES = Object.keys({
    discovered: true,
    selected: true,
    processing: true,
    ready: true,
    applied: true,
    in_progress: true,
    backlog: true,
    stale: true,
    skipped: true,
    closed: true,
  } satisfies Record<JobStatus, true>) as JobStatus[];

  it("swaps the pill on exactly the two post-application statuses", () => {
    // The positive contract, and the only assertion anywhere that reddens when
    // the BADGE rule is narrowed on a status no render test covers: those
    // cover `closed`, `skipped` and a reopened `discovered`, so suppressing
    // the badge on `ready`, `processing`, `backlog` or `stale` would otherwise
    // swap that tab's pill to the application date with the suite green.
    for (const status of ALL_STATUSES) {
      expect(showsAppliedDate({ appliedAt: marked, status })).toBe(
        status === "applied" || status === "in_progress",
      );
    }
  });

  it("gives a marked row exactly one of the badge and the date", () => {
    // Both true would say it twice on one row; both false would lose the mark
    // entirely. This catches DIVERGENCE, not un-derivation — rewriting
    // `showsAppliedDate` as an equivalent explicit list keeps it green, which
    // is correct — and while the derivation stands it is a tautology. The test
    // above is what pins which statuses actually swap.
    for (const status of ALL_STATUSES) {
      const job = { appliedAt: marked, status };
      expect(showsAppliedBadge(job) !== showsAppliedDate(job)).toBe(true);
    }
  });

  it("gives an unmarked row neither", () => {
    // The `appliedAt != null` term of each predicate. `showsAppliedDate`'s is
    // invisible from `JobRowContent`, whose ternary re-checks the stamp with
    // `dateValue` before using it — so this is the only thing holding it.
    for (const status of ALL_STATUSES) {
      const job = { appliedAt: null, status };
      expect(showsAppliedBadge(job)).toBe(false);
      expect(showsAppliedDate(job)).toBe(false);
    }
  });
});
