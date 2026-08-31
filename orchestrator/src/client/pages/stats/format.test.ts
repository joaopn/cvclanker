import { describe, expect, it } from "vitest";
import {
  barWidth,
  count,
  dayLabel,
  days,
  heatStep,
  percent,
  plural,
} from "./format";

describe("percent", () => {
  it("formats a share", () => {
    expect(percent(52, 128, 1)).toBe("40.6%");
    expect(percent(1, 4)).toBe("25%");
  });

  it("returns a dash rather than 0% when nothing has been measured", () => {
    // "0% good fit" on an unscored source reads as a verdict; it is an absence.
    expect(percent(0, 0)).toBe("—");
    expect(percent(5, 0)).toBe("—");
  });

  it("distinguishes a measured zero from an absent one", () => {
    expect(percent(0, 25)).toBe("0%");
  });

  it("survives a non-finite input", () => {
    expect(percent(Number.NaN, 10)).toBe("—");
    expect(percent(1, Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("barWidth", () => {
  it("scales against the reference", () => {
    expect(barWidth(25, 100)).toBe(25);
    expect(barWidth(50, 200)).toBe(25);
  });

  it("clamps a value that exceeds its reference", () => {
    // The funnel's later steps are not subsets of the earlier ones, so this is
    // a real case, not a defensive one.
    expect(barWidth(150, 100)).toBe(100);
  });

  it("returns zero for an empty or invalid reference", () => {
    expect(barWidth(5, 0)).toBe(0);
    expect(barWidth(5, Number.NaN)).toBe(0);
  });

  it("clamps a negative value to zero rather than inverting the bar", () => {
    expect(barWidth(-10, 100)).toBe(0);
  });
});

describe("days", () => {
  it("formats a measurement and an absence differently", () => {
    expect(days(9)).toBe("9d");
    expect(days(0)).toBe("0d");
    expect(days(null)).toBe("—");
  });
});

describe("dayLabel", () => {
  it("reads the date in UTC, matching how the server bucketed it", () => {
    expect(dayLabel("2026-08-12")).toBe("12 Aug");
    expect(dayLabel("2026-01-01")).toBe("1 Jan");
    expect(dayLabel("2026-12-31")).toBe("31 Dec");
  });

  it("still reads UTC in a timezone behind Greenwich", () => {
    // The container runs TZ=Etc/UTC, where the local and UTC getters agree —
    // so without pinning a real offset here, reading the local fields instead
    // would pass every assertion above while showing the previous day to any
    // user west of Greenwich.
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(dayLabel("2026-08-12")).toBe("12 Aug");
      expect(dayLabel("2026-01-01")).toBe("1 Jan");
    } finally {
      process.env.TZ = original;
    }
  });

  it("returns the input unchanged when it is not a date", () => {
    expect(dayLabel("nonsense")).toBe("nonsense");
  });
});

describe("heatStep", () => {
  it("keeps an empty day distinct from a quiet one", () => {
    expect(heatStep(0, 200)).toBe(0);
    expect(heatStep(1, 200)).toBe(1);
  });

  it("scales to the busiest day", () => {
    expect(heatStep(200, 200)).toBe(4);
    expect(heatStep(100, 200)).toBe(2);
    expect(heatStep(60, 200)).toBe(2);
    // Between 0.5 and 0.75: without this probe, deleting the step-3 arm is
    // invisible and `bg-chart-1/75` would never render on any install.
    expect(heatStep(130, 200)).toBe(3);
    expect(heatStep(150, 200)).toBe(3);
    expect(heatStep(160, 200)).toBe(4);
  });

  it("returns the empty step when there is no maximum", () => {
    expect(heatStep(0, 0)).toBe(0);
  });
});

describe("plural", () => {
  it("agrees with its count", () => {
    expect(plural(1, "job")).toBe("1 job");
    expect(plural(2, "job")).toBe("2 jobs");
    expect(plural(0, "job")).toBe("0 jobs");
  });
});

describe("count", () => {
  it("groups thousands", () => {
    expect(count(1234)).toContain("234");
    expect(count(1234).replace(/\D/g, "")).toBe("1234");
  });

  it("returns a dash for a value that is not a number", () => {
    expect(count(Number.NaN)).toBe("—");
    expect(count(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
