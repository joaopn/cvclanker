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
