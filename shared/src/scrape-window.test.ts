import { describe, expect, it } from "vitest";
import {
  changesScrapeCoverage,
  resolveScrapeWindowDays,
} from "./scrape-window";
import { defaultProfileConfig } from "./types/profile";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-08-12T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString();
}

describe("resolveScrapeWindowDays", () => {
  it("returns null when the source has never scraped", () => {
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: null,
        now: NOW,
        capDays: 30,
      }),
    ).toBeNull();
  });

  it("returns null for an unparseable watermark", () => {
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: "not-a-date",
        now: NOW,
        capDays: 30,
      }),
    ).toBeNull();
  });

  it("narrows to the elapsed days when inside the configured cap", () => {
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: daysAgo(3),
        now: NOW,
        capDays: 30,
      }),
    ).toBe(3);
  });

  it("rounds a partial day up so the window still reaches the watermark", () => {
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: daysAgo(2.4),
        now: NOW,
        capDays: 30,
      }),
    ).toBe(3);
  });

  it("floors at one day for a run minutes after the last one", () => {
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: new Date(NOW - 5 * 60_000).toISOString(),
        now: NOW,
        capDays: 30,
      }),
    ).toBe(1);
  });

  it("never widens past the configured cap", () => {
    // A 60-day gap under a 30-day cap: the postings between are ones the cap
    // already excluded, so the window stays at the cap.
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: daysAgo(60),
        now: NOW,
        capDays: 30,
      }),
    ).toBe(30);
  });

  it("uses the elapsed days when no cap is configured", () => {
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: daysAgo(9),
        now: NOW,
        capDays: null,
      }),
    ).toBe(9);
  });

  it("clamps an uncapped long gap to the max window", () => {
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: daysAgo(900),
        now: NOW,
        capDays: null,
      }),
    ).toBe(365);
  });

  it("falls back to the configured window for a watermark in the future", () => {
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: daysAgo(-2),
        now: NOW,
        capDays: 30,
      }),
    ).toBeNull();
  });

  it("accepts a Date for now", () => {
    expect(
      resolveScrapeWindowDays({
        lastScrapedAt: daysAgo(4),
        now: new Date(NOW),
        capDays: null,
      }),
    ).toBe(4);
  });
});

describe("changesScrapeCoverage", () => {
  const existing = defaultProfileConfig();

  it("reports the fields that change what a run would cover", () => {
    expect(changesScrapeCoverage(existing, { searchTerms: ["new term"] })).toBe(
      true,
    );
    expect(changesScrapeCoverage(existing, { searchCountry: "canada" })).toBe(
      true,
    );
    expect(changesScrapeCoverage(existing, { remoteProfile: true })).toBe(true);
    expect(
      changesScrapeCoverage(existing, { remoteLocationBlocklist: ["US only"] }),
    ).toBe(true);
    expect(changesScrapeCoverage(existing, { scrapeMaxAgeDays: 14 })).toBe(
      true,
    );
  });

  it("ignores volume knobs, source selection, and unchanged values", () => {
    expect(changesScrapeCoverage(existing, { runBudget: 999 })).toBe(false);
    expect(changesScrapeCoverage(existing, { topN: 1 })).toBe(false);
    expect(
      changesScrapeCoverage(existing, { enabledSourceIds: ["jobspy"] }),
    ).toBe(false);
    expect(
      changesScrapeCoverage(existing, { searchTerms: existing.searchTerms }),
    ).toBe(false);
    expect(changesScrapeCoverage(existing, {})).toBe(false);
  });
});
