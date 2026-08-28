import type { ProfileConfig } from "./types/profile.js";

/**
 * "Scrape since the last run": narrow a source's max-job-age window to the
 * time actually elapsed since that source last scraped successfully, so a
 * continuously-running install stops re-fetching the same weeks-old postings
 * on every run.
 *
 * The window must never leave a gap. Two things make that hold:
 *
 *  - The watermark is the *start* of the run that last scraped the source, not
 *    the moment the source's request went out. The request is always later, so
 *    the previous run's coverage starts strictly before the watermark.
 *  - The elapsed time is rounded UP to a whole day (sources take a day count),
 *    so the computed window always reaches at least back to the watermark.
 *
 * The result is also capped by whatever max-age the user configured, so the
 * flag can only ever narrow the window relative to what the run would have
 * scraped anyway — never widen it past the user's intent. A gap wider than
 * that cap is a gap the user already accepted.
 */

const DAY_MS = 86_400_000;

/** Upper bound on any computed window, matching the max-age field's own cap. */
export const SCRAPE_WINDOW_MAX_DAYS = 365;

export interface ScrapeWindowArgs {
  /** ISO timestamp of the start of the run that last scraped this source. */
  lastScrapedAt: string | null | undefined;
  /** Reference time — the current run's start. */
  now: Date | number;
  /**
   * The max-age the run would otherwise use for this source (the Search
   * Profile's cap, or a per-instance override). `null`/`undefined` = uncapped,
   * i.e. the source's own default window.
   */
  capDays: number | null | undefined;
}

/**
 * Effective max job age in days, or `null` when there is nothing usable to
 * derive one from (no watermark, unparseable watermark, or a watermark in the
 * future). `null` means "leave the configured behaviour alone".
 */
export function resolveScrapeWindowDays(args: ScrapeWindowArgs): number | null {
  const { lastScrapedAt, capDays } = args;
  if (!lastScrapedAt) return null;

  const last = Date.parse(lastScrapedAt);
  if (!Number.isFinite(last)) return null;

  const now = typeof args.now === "number" ? args.now : args.now.getTime();
  const elapsedMs = now - last;
  // A watermark in the future means a clock change or a corrupt row. Falling
  // back to the configured window is the safe read: it cannot lose postings.
  if (elapsedMs < 0) return null;

  let days = Math.max(1, Math.ceil(elapsedMs / DAY_MS));
  if (typeof capDays === "number" && Number.isFinite(capDays) && capDays > 0) {
    days = Math.min(days, Math.floor(capDays));
  }
  return Math.max(1, Math.min(SCRAPE_WINDOW_MAX_DAYS, days));
}

/**
 * The Search Profile fields that shape WHAT a run would have covered, as
 * opposed to how much of it a run takes. Changing one invalidates every
 * watermark: a narrowed window is only safe while the previous run looked for
 * the same things.
 *
 * Deliberately excluded: source selection (a newly-ticked source has no
 * watermark of its own, and an un-ticked one keeps a mark it will not read),
 * and the volume knobs (runBudget / topN), which cap how much a run takes
 * rather than how far back it looks.
 *
 * One list, two consumers: the repository clears the watermarks, and the
 * profile editor tells the user its next run will scrape the full window
 * again. A second copy would drift into a silent lie in one of the two.
 */
export const SCRAPE_COVERAGE_FIELDS = [
  "searchTerms",
  "searchCountry",
  "searchCities",
  "workplaceTypes",
  "locationSearchScope",
  "locationMatchStrictness",
  "remoteProfile",
  "remoteLocationBlocklist",
  "scrapeMaxAgeDays",
] as const satisfies ReadonlyArray<keyof ProfileConfig>;

/** Whether a patch changes what a run would cover, i.e. drops the watermarks. */
export function changesScrapeCoverage(
  existing: ProfileConfig,
  patch: Partial<ProfileConfig>,
): boolean {
  return SCRAPE_COVERAGE_FIELDS.some(
    (field) =>
      field in patch &&
      JSON.stringify(patch[field]) !== JSON.stringify(existing[field]),
  );
}

/** One source's contribution to the watermark write after a run. */
export interface ScrapedSourceMark {
  /** Discovery task id: an extractor manifest id, or `<provider>:<instance>`. */
  sourceKey: string;
  /**
   * The window the source actually ran with, in days.
   *
   * `Infinity` for a source with no max-age concept at all — it returns its
   * whole feed, so it covers any gap. `null` when the span is unknown: the
   * source fell back to its own default and nothing at this layer can say how
   * far back that reaches.
   */
  windowDays: number | null;
  /**
   * The standing max job age this source is configured with, in days, or `null`
   * when uncapped. Carried alongside the window because the advance rule needs
   * both: a run at the policy width leaves only the hole the policy defines,
   * while one narrowed below it leaves a hole nobody asked for.
   */
  policyWindowDays: number | null;
}

/**
 * Where a source's watermark should sit after a run.
 *
 * The mark means **"coverage is continuous up to here"**. A run at
 * `runStartedAt` with window `windowDays` covers
 * `[runStartedAt - windowDays, runStartedAt]`, so the mark may only move when
 * the run fetched everything it was ever going to fetch — which is
 * `min(the gap since the last mark, the standing policy window)`:
 *
 *  - **the gap**, because anything older than the last mark is already covered;
 *  - **the policy window** (`policyWindowDays`, the profile's configured max job
 *    age), because a user who caps at 7 days has said they never want postings
 *    older than that. The band beyond it is out of scope by their own
 *    configuration, not coverage this run lost.
 *
 * That second clause is what keeps a one-off narrow run honest while leaving
 * the configured cap free to do its job. A run narrowed BELOW the policy — the
 * user asking for "just today" after a four-day gap — leaves a hole nobody
 * asked for, and the mark holds so a later run reaches back over it. A run at
 * the policy width leaves only the hole the policy itself defines, and the mark
 * advances.
 *
 * Note it is the previous mark that survives a hole, never `previous + window`:
 * coverage is continuous only up to `previous`, so anything later is the hole.
 *
 * Returns the new ISO timestamp, or `null` to leave the existing mark alone.
 */
export function resolveWatermarkAdvance(args: {
  previous: string | null | undefined;
  runStartedAt: string;
  windowDays: number | null;
  /**
   * The standing max job age for this source, in days; `null`/absent for an
   * uncapped profile, where only closing the gap can advance the mark.
   */
  policyWindowDays?: number | null;
}): string | null {
  const { previous, runStartedAt, windowDays, policyWindowDays } = args;

  // No prior mark: this run establishes the boundary, whatever its window.
  //
  // The mark records where coverage ENDS, not where it begins, so a first run
  // cannot break continuity — there is nothing yet for it to be continuous
  // with. It also has to come before the unknown-window check, because an
  // uncapped profile's first run has no window to speak of and declining here
  // would leave it without a mark forever, making the whole feature a
  // permanent no-op on the default profile.
  //
  // Accepted consequence: a deliberately narrow run against a source with no
  // mark — newly ticked, or just cleared by a profile edit — establishes the
  // boundary at this run rather than triggering a full re-scan later. That is
  // what was asked for, and the run menu shows such a source as never scraped.
  if (!previous) return runStartedAt;

  const prev = Date.parse(previous);
  const now = Date.parse(runStartedAt);
  // An unparseable or future mark is not a boundary anything can reason about
  // (`resolveScrapeWindowDays` also refuses to narrow against one). Replacing
  // it with this run's start is honest and self-healing.
  if (!Number.isFinite(prev) || !Number.isFinite(now)) return runStartedAt;
  if (prev > now) return runStartedAt;

  // Unknown span: we cannot show the run met what was required of it. Holding
  // is the safe direction to be wrong in — a stale mark only widens the next
  // window, where a premature one skips postings nothing ever fetched.
  if (windowDays === null) return null;

  const gapDays = (now - prev) / DAY_MS;
  const policy =
    typeof policyWindowDays === "number" &&
    Number.isFinite(policyWindowDays) &&
    policyWindowDays > 0
      ? policyWindowDays
      : Number.POSITIVE_INFINITY;

  return windowDays >= Math.min(gapDays, policy) ? runStartedAt : null;
}

/**
 * Snap a requested window onto the discrete set some sources accept.
 *
 * A few actors express recency as an enum of fixed windows rather than a day
 * count. Below the widest entry the request rounds UP to the tightest window
 * that still covers it, so nothing in range is excluded — at the cost of
 * fetching more than asked, which on a pay-per-result actor is money.
 *
 * **The last entry is a CLAMP, not a bucket.** A request wider than it comes
 * back as that entry, because the source simply cannot express more. That
 * direction loses coverage rather than costing money, so callers must treat it
 * as a different answer from a round-up — compare the result against the
 * request to tell them apart.
 */
export function bucketWindowDays(
  days: number,
  buckets: readonly number[],
): number {
  if (buckets.length === 0) return days;
  return (
    buckets.find((bucket) => days <= bucket) ?? buckets[buckets.length - 1]
  );
}
