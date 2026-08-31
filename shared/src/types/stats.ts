/**
 * Statistics surface: aggregates computed from the `jobs` table.
 *
 * Every number here is derived from columns that already exist. Two things the
 * schema cannot express are surfaced as explicit flags rather than guessed at:
 * which search term found a job (no extractor reports it), and per-run scrape
 * yield (the funnel counters live in the in-memory progress store).
 */

import type { SuitabilityCategory } from "./jobs";

/**
 * How long an application may sit unanswered before it is shown as ghosted
 * rather than merely waiting.
 *
 * This threshold changes a LABEL only. It never writes anything, and it does
 * not enter the reply rate — a ghosted application and a waiting one are both
 * "no reply", so moving this number redistributes two display buckets and
 * changes no rate on the page.
 */
export const GHOSTED_AFTER_DAYS = 21;

/** Reply-time histogram buckets, in days since the application was sent. */
export const REPLY_TIME_BUCKETS = [
  { key: "0-3", minDays: 0, maxDays: 3 },
  { key: "4-7", minDays: 4, maxDays: 7 },
  { key: "8-14", minDays: 8, maxDays: 14 },
  { key: "15-21", minDays: 15, maxDays: 21 },
  { key: "22+", minDays: 22, maxDays: null },
] as const;

export type ReplyTimeBucketKey = (typeof REPLY_TIME_BUCKETS)[number]["key"];

/**
 * Filters every stats endpoint accepts.
 *
 * `sinceDays` is applied to each endpoint's OWN natural date column —
 * `discovered_at` for overview/discovery/companies, `applied_at` for
 * applications — because "the last 30 days" means a different thing to a job
 * that was found then and an application that was sent then.
 */
export interface StatsQuery {
  /** null = all time. */
  sinceDays: number | null;
  /** null = every profile, including rows with no profile attribution. */
  profileId: string | null;
}

/**
 * Whether a funnel step is backed by a permanent mark or by the row's CURRENT
 * state. `status` is not cumulative and scores are overwritten, so "ever
 * scored" is not computable — only "scored right now" is. The client says so
 * rather than implying the funnel is a history.
 */
export type StatsFunnelBasis = "permanent" | "current";

export interface StatsFunnelStep {
  key: "found" | "scored" | "good_fit" | "tailored" | "applied";
  label: string;
  count: number;
  basis: StatsFunnelBasis;
  /**
   * Whether this step is a strict subset of the one before it. False for
   * `tailored` and `applied`: nothing stops a bad-fit job being tailored and
   * applied to, so those steps can legitimately EXCEED the good-fit step. A
   * renderer that assumes a funnel only narrows would draw a widening bar and
   * imply a counting bug where there is none.
   */
  nested: boolean;
}

/**
 * What the user did with each fit rating.
 *
 * Buckets are mutually exclusive and sum to `total`. Precedence is
 * `skipped > applied > tailored > closed > inInbox`: the STRONGEST signal of
 * what the user did wins, except an explicit skip, which is a deliberate
 * rejection and outranks everything.
 *
 * Each column therefore means "reached this and no further": `tailored` is
 * tailored-but-not-applied, and `closed` is closed without ever being tailored
 * or applied. Without the `applied` arm, a job applied to straight from the
 * inbox — the apply route writes `status` only, never `ready_at` — would land
 * in `inInbox` and render the strongest action as no action at all.
 */
export interface StatsCalibrationRow {
  category: SuitabilityCategory | "unscored";
  skipped: number;
  applied: number;
  tailored: number;
  closed: number;
  inInbox: number;
  total: number;
}

/** One UTC day. SQLite's date functions are UTC and the container runs Etc/UTC. */
export interface StatsActivityDay {
  date: string;
  count: number;
}

export interface StatsOverview {
  found: number;
  scored: number;
  unscored: number;
  goodFit: number;
  tailored: number;
  applied: number;
  funnel: StatsFunnelStep[];
  calibration: StatsCalibrationRow[];
  activity: StatsActivityDay[];
}

export interface StatsSourceRow {
  /**
   * The raw `jobs.source` value: a board/platform id (`linkedin`, `indeed`,
   * `hiringcafe`), or `apify:<instanceId>` for a provider instance. Note this
   * is a BOARD, not a scraper — jobspy alone supplies three of them.
   */
  source: string;
  /** Human label resolved server-side; falls back safely for unknown ids. */
  label: string;
  jobs: number;
  scored: number;
  goodFit: number;
}

export interface StatsProfileRow {
  /** null = discovered before profile attribution existed, or by no profile. */
  profileId: string | null;
  name: string;
  jobs: number;
  goodFit: number;
}

export interface StatsDiscovery {
  sources: StatsSourceRow[];
  profiles: StatsProfileRow[];
  /**
   * False, and not a TODO: extractors are handed the whole search-terms array
   * and return a flat job list, and four of them OR every term into a single
   * query, so no job can currently name the term that found it.
   */
  termAttributionAvailable: boolean;
  /**
   * False: per-source scrape counters (scraped / filtered / unmappable) live
   * in the in-memory progress store and do not survive a restart.
   */
  perRunYieldAvailable: boolean;
}

export interface StatsReplyTimeBucket {
  key: ReplyTimeBucketKey;
  label: string;
  count: number;
}

/** One outstanding application: sent, no outcome recorded, still at Applied. */
export interface StatsOutstandingRow {
  id: string;
  title: string;
  employer: string;
  appliedAt: string;
  daysWaiting: number;
  liveClosed: boolean | null;
}

/**
 * The application buckets partition the applied set exactly — every job with an
 * `applied_at` lands in exactly one of them, `movedOn` included. That bucket is
 * not a rounding error: reopening a closed job clears its outcome but keeps the
 * applied mark, and a swept or skipped row does the same, so without it the
 * buckets would not sum to `applied` and the page would show a total that does
 * not add up.
 */
export interface StatsApplications {
  applied: number;
  /**
   * Rejections plus jobs now at Interviewing. A FLOOR, not an exact count:
   * there is no stage history, so a job that reached Interviewing and was then
   * closed as withdrawn/other can no longer be seen to have had a reply.
   *
   * Where a row carries both signals — `in_progress` AND a recorded outcome,
   * reachable because the outcome and status writes are two separate requests
   * — the Interviewing status wins, so it counts as `advanced`.
   */
  heardBack: number;
  rejected: number;
  advanced: number;
  /** Recorded by the user as the `ghosted` outcome. */
  ghostedRecorded: number;
  /** Derived: still at Applied, no outcome, older than GHOSTED_AFTER_DAYS. */
  ghostedDerived: number;
  stillWaiting: number;
  closedOther: number;
  movedOn: number;
  /**
   * Median days to reply, over closed applications only. Null when none.
   *
   * RIGHT-CENSORED by the range filter, which selects on when an application
   * was SENT: a narrow window keeps recent applications whose slow replies have
   * not arrived yet, so the median reads low and reads lower the narrower the
   * window. `replyTimeSampleSize` is what lets the client say so.
   */
  medianReplyDays: number | null;
  replyTimeBuckets: StatsReplyTimeBucket[];
  /** How many closed applications carried a usable pair of timestamps. */
  replyTimeSampleSize: number;
  /**
   * Every outstanding application, oldest first — which is
   * `stillWaiting + ghostedDerived`, NOT `stillWaiting` alone. Listing only the
   * fresh ones would hide exactly the applications worth chasing, and listing
   * the wider set under the narrower count is why this field is not called
   * `waiting`. Capped; `outstandingTotal` is the uncapped size.
   */
  outstanding: StatsOutstandingRow[];
  outstandingTotal: number;
}

export interface StatsCompanyRow {
  /** Lower-cased grouping key, matching the jobs list's employer filter. */
  key: string;
  employer: string;
  jobs: number;
  goodFit: number;
  applied: number;
}

export interface StatsCompanies {
  companies: StatsCompanyRow[];
  /** Jobs seen re-posted at least once under the same URL. */
  repostedJobs: number;
  /** Jobs the board now reports closed, in whatever state they are held. */
  liveClosedJobs: number;
  /**
   * Jobs carrying a live-status verdict. Deliberately reported as a COUNT and
   * never as a share of `totalJobs`: live status only exists for LinkedIn-shaped
   * rows, so a percentage against every job would read as near-total neglect on
   * any multi-board install.
   */
  liveStatusChecked: number;
  totalJobs: number;
}
