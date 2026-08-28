import { describe, expect, it } from "vitest";
import {
  bucketWindowDays,
  changesScrapeCoverage,
  resolveScrapeWindowDays,
  resolveWatermarkAdvance,
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

describe("resolveWatermarkAdvance", () => {
  const RUN_STARTED_AT = new Date(NOW).toISOString();

  const advance = (args: {
    previous?: string | null;
    windowDays: number | null;
    policyWindowDays?: number | null;
  }) =>
    resolveWatermarkAdvance({
      previous: args.previous ?? null,
      runStartedAt: RUN_STARTED_AT,
      windowDays: args.windowDays,
      policyWindowDays: args.policyWindowDays ?? null,
    });

  it("establishes the boundary when there is no previous mark", () => {
    expect(advance({ windowDays: 1 })).toBe(RUN_STARTED_AT);
  });

  /**
   * The bootstrap case, and the reason this arm precedes the unknown-window
   * one: an uncapped profile's FIRST run has no window to speak of. Declining
   * to write here would leave it without a mark forever, which makes "scrape
   * since the last run" a permanent no-op on the default profile.
   */
  it("establishes the boundary even when the window is unknown", () => {
    expect(advance({ windowDays: null })).toBe(RUN_STARTED_AT);
  });

  it("advances when the window reaches back to the previous mark", () => {
    expect(advance({ previous: daysAgo(3), windowDays: 3 })).toBe(
      RUN_STARTED_AT,
    );
  });

  it("advances when the window reaches further back than the mark", () => {
    expect(advance({ previous: daysAgo(2), windowDays: 30 })).toBe(
      RUN_STARTED_AT,
    );
  });

  /**
   * The failure this rule exists to prevent: a narrow one-off run after a long
   * gap leaves postings nobody fetched. Moving the mark would claim them, and
   * every later narrowed window would start after them.
   */
  it("holds the mark when a run narrower than policy left a hole", () => {
    expect(
      advance({ previous: daysAgo(4), windowDays: 1, policyWindowDays: 30 }),
    ).toBeNull();
  });

  /**
   * A user who caps at 7 days has said they never want postings older than
   * that, so the 8-30d band is out of scope by their own configuration rather
   * than coverage this run lost. Advancing is what keeps a capped profile from
   * freezing at one outage and then scraping the full cap on every run forever.
   */
  it("advances when the run covered the whole policy window", () => {
    expect(
      advance({ previous: daysAgo(30), windowDays: 7, policyWindowDays: 7 }),
    ).toBe(RUN_STARTED_AT);
  });

  it("holds when the run fell short of BOTH the gap and the policy", () => {
    expect(
      advance({ previous: daysAgo(30), windowDays: 3, policyWindowDays: 7 }),
    ).toBeNull();
  });

  /**
   * A source with no max-age concept returns its whole feed, so it covers any
   * gap. Reporting it as a capped window would freeze its mark for no reason.
   */
  it("always advances an unbounded source", () => {
    expect(
      advance({
        previous: daysAgo(400),
        windowDays: Number.POSITIVE_INFINITY,
      }),
    ).toBe(RUN_STARTED_AT);
  });

  it("holds the mark when the window is unknown", () => {
    expect(advance({ previous: daysAgo(10), windowDays: null })).toBeNull();
  });

  it("resets an unparseable mark to this run rather than reasoning about it", () => {
    expect(advance({ previous: "not-a-date", windowDays: 1 })).toBe(
      RUN_STARTED_AT,
    );
  });

  it("resets a future mark to this run", () => {
    expect(
      advance({
        previous: new Date(NOW + 5 * DAY_MS).toISOString(),
        windowDays: 1,
      }),
    ).toBe(RUN_STARTED_AT);
  });

  /**
   * `resolveScrapeWindowDays` rounds elapsed UP, so a "since last run" window
   * on an uncapped profile always covers its own gap. Pinned because it is what
   * makes the flag's behaviour unchanged by this rule.
   */
  it("always advances a window derived from the mark itself", () => {
    // Both cap shapes: uncapped, and a cap WIDER than the gap (where the cap
    // does not clamp and the derived window is the elapsed time).
    for (const capDays of [null, 60]) {
      for (const elapsed of [0.1, 1, 1.5, 7, 29.4]) {
        const previous = daysAgo(elapsed);
        const windowDays = resolveScrapeWindowDays({
          lastScrapedAt: previous,
          now: NOW,
          capDays,
        });
        expect(windowDays).not.toBeNull();
        expect(
          advance({ previous, windowDays, policyWindowDays: capDays }),
        ).toBe(RUN_STARTED_AT);
      }
    }
  });

  it("advances when the mark is exactly this run's start", () => {
    expect(advance({ previous: RUN_STARTED_AT, windowDays: 1 })).toBe(
      RUN_STARTED_AT,
    );
  });

  /**
   * ...and the same holds once a cap clamps that window below the elapsed time,
   * because the cap IS the policy. This is the case that would otherwise pin a
   * profile to scraping its full cap on every run after a single outage.
   */
  it("advances a capped derived window even when it is shorter than the gap", () => {
    const previous = daysAgo(30);
    const windowDays = resolveScrapeWindowDays({
      lastScrapedAt: previous,
      now: NOW,
      capDays: 7,
    });
    expect(windowDays).toBe(7);
    expect(advance({ previous, windowDays, policyWindowDays: 7 })).toBe(
      RUN_STARTED_AT,
    );
  });
});

describe("bucketWindowDays", () => {
  const BUCKETS = [1, 7, 30];

  it("returns an exact bucket unchanged", () => {
    expect(bucketWindowDays(1, BUCKETS)).toBe(1);
    expect(bucketWindowDays(7, BUCKETS)).toBe(7);
    expect(bucketWindowDays(30, BUCKETS)).toBe(30);
  });

  it("rounds up to the tightest bucket that still covers the request", () => {
    expect(bucketWindowDays(2, BUCKETS)).toBe(7);
    expect(bucketWindowDays(6.5, BUCKETS)).toBe(7);
    expect(bucketWindowDays(8, BUCKETS)).toBe(30);
  });

  /**
   * The asymmetry that matters: below the widest bucket the caller gets MORE
   * than it asked for (a cost), above it the caller gets LESS (a coverage
   * loss). Comparing the result to the request is the only way to tell.
   */
  it("clamps a request wider than the widest bucket", () => {
    expect(bucketWindowDays(31, BUCKETS)).toBe(30);
    expect(bucketWindowDays(365, BUCKETS)).toBe(30);
  });

  it("leaves the request alone when there are no buckets", () => {
    expect(bucketWindowDays(42, [])).toBe(42);
  });
});
