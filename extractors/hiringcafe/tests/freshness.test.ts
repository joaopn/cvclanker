import { describe, expect, it } from "vitest";
import {
  isWithinPublishWindow,
  PUBLISH_DATE_TOLERANCE_DAYS,
} from "../src/freshness";

const NOW_MS = Date.parse("2026-08-17T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;
const daysAgo = (days: number) =>
  new Date(NOW_MS - days * MS_PER_DAY).toISOString();

const within = (
  estimatedPublishDate: string | null | undefined,
  windowDays = 7,
) => isWithinPublishWindow({ estimatedPublishDate, windowDays, nowMs: NOW_MS });

describe("isWithinPublishWindow", () => {
  it("keeps postings published inside the window", () => {
    expect(within(daysAgo(0))).toBe(true);
    expect(within(daysAgo(3))).toBe(true);
    expect(within(daysAgo(7))).toBe(true);
  });

  it("keeps postings inside the estimate tolerance and drops the rest", () => {
    expect(within(daysAgo(7 + PUBLISH_DATE_TOLERANCE_DAYS))).toBe(true);
    expect(within(daysAgo(7 + PUBLISH_DATE_TOLERANCE_DAYS + 0.5))).toBe(false);
    // The 98-day averages this was reported on.
    expect(within(daysAgo(98))).toBe(false);
    expect(within(daysAgo(1967))).toBe(false);
  });

  it("scales with the requested window", () => {
    expect(within(daysAgo(20), 30)).toBe(true);
    expect(within(daysAgo(20), 7)).toBe(false);
    expect(within(daysAgo(2), 1)).toBe(true);
    expect(within(daysAgo(4), 1)).toBe(false);
  });

  it("fails open when there is no window or no usable date", () => {
    expect(within(daysAgo(98), 0)).toBe(true);
    expect(within(daysAgo(98), Number.NaN)).toBe(true);
    expect(within(null)).toBe(true);
    expect(within(undefined)).toBe(true);
    expect(within("")).toBe(true);
    expect(within("not a date")).toBe(true);
  });

  it("keeps a posting dated in the future", () => {
    expect(within(daysAgo(-3))).toBe(true);
  });
});
