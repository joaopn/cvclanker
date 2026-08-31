/**
 * Aggregates for the Stats surface.
 *
 * Every query here reads the `jobs` table only. Three traps govern the SQL and
 * are load-bearing rather than defensive habit:
 *
 * 1. **Both sides of a date comparison go through `datetime()`.** The date
 *    columns hold ISO-8601 with `T`/`Z` while `datetime('now', ...)` yields a
 *    space-separated form, and SQLite compares TEXT lexically — so a raw
 *    comparison is wrong by up to a full day and still passes any coarse
 *    fixture ('2026-08-01T02:00:00.000Z' >= '2026-08-01 12:00:00' is TRUE).
 *    `discovered_at` also carries a `DEFAULT (datetime('now'))`, so the column
 *    is structurally able to hold both shapes.
 * 2. **`suitability_category IN (...)` is never true for NULL**, so "unscored"
 *    is always an explicit `IS NULL` arm, never the negation of a set.
 * 3. **`closed_at` is Unix SECONDS while `applied_at` is ISO text**, so a
 *    duration between them needs `datetime(closed_at, 'unixepoch')`.
 */

import { isExtractorSourceId, sourceLabel } from "@shared/extractors";
import type {
  StatsActivityDay,
  StatsApplications,
  StatsCalibrationRow,
  StatsCompanies,
  StatsCompanyRow,
  StatsDiscovery,
  StatsOutstandingRow,
  StatsOverview,
  StatsProfileRow,
  StatsQuery,
  StatsReplyTimeBucket,
  StatsSourceRow,
  SuitabilityCategory,
} from "@shared/types";
import { GHOSTED_AFTER_DAYS, REPLY_TIME_BUCKETS } from "@shared/types";
import { type AnyColumn, and, type SQL, sql } from "drizzle-orm";
import { db, schema } from "../db/index";
import {
  isProviderInstanceSource,
  resolveSourceDisplayLabel,
} from "../services/sources/display";
import { getAllProviderInstances } from "./provider-instances";

const { jobs, profiles } = schema;

/**
 * Row caps for the two list-shaped payloads. Both are display limits on a
 * dashboard panel, not correctness bounds: the companies table reports its own
 * cut, and the outstanding list reports `outstandingTotal` beside it, so
 * neither can silently look complete when it is not.
 */
const COMPANY_LIMIT = 25;
const OUTSTANDING_LIMIT = 20;

/** The suitability tiers that count as a usable match. */
const goodFitSql = sql`${jobs.suitabilityCategory} in ('good_fit','very_good_fit','great_fit')`;

/**
 * A date column compared safely against a cutoff. Unparseable text collapses to
 * a far-past sentinel so a corrupt row reads as old rather than as "now" —
 * consistent with how the live-status floor treats a bad timestamp.
 */
function withinRange(column: AnyColumn, sinceDays: number) {
  return sql`coalesce(datetime(${column}), '0001-01-01 00:00:00') >= datetime('now', ${`-${sinceDays} days`})`;
}

/**
 * Filters shared by the overview, discovery and companies endpoints, which are
 * all about jobs as they were FOUND.
 */
function discoveryFilters(query: StatsQuery): SQL | undefined {
  const clauses: SQL[] = [];
  if (query.sinceDays !== null) {
    clauses.push(withinRange(jobs.discoveredAt, query.sinceDays));
  }
  if (query.profileId !== null) {
    clauses.push(sql`${jobs.profileId} = ${query.profileId}`);
  }
  if (clauses.length === 0) return undefined;
  return and(...clauses);
}

/** Filters for the applications endpoint, which is about jobs as SENT. */
function applicationFilters(query: StatsQuery): SQL {
  const clauses: SQL[] = [sql`${jobs.appliedAt} is not null`];
  if (query.sinceDays !== null) {
    clauses.push(withinRange(jobs.appliedAt, query.sinceDays));
  }
  if (query.profileId !== null) {
    clauses.push(sql`${jobs.profileId} = ${query.profileId}`);
  }
  return and(...clauses) as SQL;
}

/**
 * Overview: headline totals, the funnel, the fit-versus-action crosstab and
 * the daily activity series.
 */
export async function getOverviewStats(
  query: StatsQuery,
): Promise<StatsOverview> {
  const where = discoveryFilters(query);

  const base = () => {
    const q = db
      .select({
        found: sql<number>`count(*)`,
        scored: sql<number>`sum(case when ${jobs.suitabilityCategory} is not null then 1 else 0 end)`,
        goodFit: sql<number>`sum(case when ${goodFitSql} then 1 else 0 end)`,
        tailored: sql<number>`sum(case when ${jobs.readyAt} is not null then 1 else 0 end)`,
        applied: sql<number>`sum(case when ${jobs.appliedAt} is not null then 1 else 0 end)`,
      })
      .from(jobs);
    return where ? q.where(where) : q;
  };

  const [totalsRow] = await base();
  const found = totalsRow?.found ?? 0;
  const scored = totalsRow?.scored ?? 0;
  const goodFit = totalsRow?.goodFit ?? 0;
  const tailored = totalsRow?.tailored ?? 0;
  const applied = totalsRow?.applied ?? 0;

  const calibration = await getCalibration(where);
  const activity = await getActivity(where);

  return {
    found,
    scored,
    unscored: found - scored,
    goodFit,
    tailored,
    applied,
    funnel: [
      {
        key: "found",
        label: "Found",
        count: found,
        basis: "permanent",
        nested: false,
      },
      {
        key: "scored",
        label: "Scored",
        count: scored,
        basis: "current",
        nested: true,
      },
      {
        key: "good_fit",
        label: "Good fit or better",
        count: goodFit,
        basis: "current",
        nested: true,
      },
      // Not nested: a bad-fit job can be tailored and applied to, so these two
      // steps are counted over the whole range and may exceed the one above.
      {
        key: "tailored",
        label: "Tailored",
        count: tailored,
        basis: "permanent",
        nested: false,
      },
      {
        key: "applied",
        label: "Applied",
        count: applied,
        basis: "permanent",
        nested: false,
      },
    ],
    calibration,
    activity,
  };
}

/**
 * What the user did with each fit rating.
 *
 * The CASE is a precedence chain, so the buckets are mutually exclusive by
 * construction and sum to the row count. Precedence is STRONGEST ACTION first —
 * applied beats tailored beats closed — with an explicit skip outranking
 * everything as a deliberate rejection. So each column reads "got this far and
 * no further", and `closed` means closed without ever being tailored or applied.
 *
 * The `applied` arm is load-bearing rather than tidy: the apply route writes
 * `status` only and never stamps `ready_at`, so a job applied to straight from
 * the inbox has no tailoring mark and would otherwise fall to `inbox` — the
 * strongest action rendered as no action.
 *
 * `outcome is not null` is the closed test rather than `status = 'closed'`: the
 * outcome PATCH and the status PATCH are two separate calls, so a row can carry
 * an outcome while still reading `applied`, and gating on status would make two
 * panels disagree.
 */
async function getCalibration(
  where: SQL | undefined,
): Promise<StatsCalibrationRow[]> {
  const bucket = sql<string>`case
    when ${jobs.status} = 'skipped' then 'skipped'
    when ${jobs.appliedAt} is not null then 'applied'
    when ${jobs.readyAt} is not null then 'tailored'
    when ${jobs.outcome} is not null then 'closed'
    else 'inbox'
  end`;
  const category = sql<string>`coalesce(${jobs.suitabilityCategory}, 'unscored')`;

  const q = db
    .select({ category, bucket, count: sql<number>`count(*)` })
    .from(jobs)
    .groupBy(category, bucket);
  const rows = where ? await q.where(where) : await q;

  const order: Array<SuitabilityCategory | "unscored"> = [
    "great_fit",
    "very_good_fit",
    "good_fit",
    "bad_fit",
    "unscored",
  ];
  const byCategory = new Map<string, StatsCalibrationRow>();
  for (const key of order) {
    byCategory.set(key, {
      category: key,
      skipped: 0,
      applied: 0,
      tailored: 0,
      closed: 0,
      inInbox: 0,
      total: 0,
    });
  }
  for (const row of rows) {
    const entry = byCategory.get(row.category);
    if (!entry) continue;
    if (row.bucket === "skipped") entry.skipped = row.count;
    else if (row.bucket === "applied") entry.applied = row.count;
    else if (row.bucket === "tailored") entry.tailored = row.count;
    else if (row.bucket === "closed") entry.closed = row.count;
    else entry.inInbox = row.count;
    entry.total += row.count;
  }
  return order.map((key) => byCategory.get(key) as StatsCalibrationRow);
}

/**
 * Jobs found per day. Bucketed in UTC — SQLite's date functions are UTC and the
 * container runs `TZ=Etc/UTC` — which the client labels rather than silently
 * re-bucketing into the viewer's zone.
 */
async function getActivity(
  where: SQL | undefined,
): Promise<StatsActivityDay[]> {
  const day = sql<string>`date(datetime(${jobs.discoveredAt}))`;
  const q = db
    .select({ date: day, count: sql<number>`count(*)` })
    .from(jobs)
    .groupBy(day)
    .orderBy(day);
  const rows = where ? await q.where(where) : await q;
  return rows
    .filter((row): row is StatsActivityDay => typeof row.date === "string")
    .map((row) => ({ date: row.date, count: row.count }));
}

/** Per-source and per-profile yield. */
export async function getDiscoveryStats(
  query: StatsQuery,
): Promise<StatsDiscovery> {
  const where = discoveryFilters(query);

  const sourceQuery = db
    .select({
      source: jobs.source,
      jobs: sql<number>`count(*)`,
      scored: sql<number>`sum(case when ${jobs.suitabilityCategory} is not null then 1 else 0 end)`,
      goodFit: sql<number>`sum(case when ${goodFitSql} then 1 else 0 end)`,
    })
    .from(jobs)
    .groupBy(jobs.source);
  const sourceRows = where ? await sourceQuery.where(where) : await sourceQuery;

  // `jobs.source` is unconstrained free text (no enum, no CHECK), and an Apify
  // row carries the synthetic `apify:<instanceId>`.
  //
  // Extractor ids are labelled by BOARD, not by scraper: resolveSourceDisplayLabel
  // answers "jobspy" for linkedin, indeed AND glassdoor alike, which is right for
  // a per-row badge and useless in an aggregate table — it would render three
  // separate rows all called jobspy. Provider instances still go through it, since
  // their label is the user's own and lives on the instance row.
  const needsInstances = sourceRows.some((row) =>
    isProviderInstanceSource(row.source),
  );
  const providerInstances = needsInstances
    ? await getAllProviderInstances()
    : [];
  const sources: StatsSourceRow[] = sourceRows
    .map((row) => ({
      source: row.source,
      label: isExtractorSourceId(row.source)
        ? sourceLabel(row.source)
        : resolveSourceDisplayLabel({
            source: row.source,
            providerInstances,
          }),
      jobs: row.jobs,
      scored: row.scored,
      goodFit: row.goodFit,
    }))
    .sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));

  const profileQuery = db
    .select({
      profileId: jobs.profileId,
      jobs: sql<number>`count(*)`,
      goodFit: sql<number>`sum(case when ${goodFitSql} then 1 else 0 end)`,
    })
    .from(jobs)
    .groupBy(jobs.profileId);
  const profileRows = where
    ? await profileQuery.where(where)
    : await profileQuery;

  const profileNames = new Map<string, string>();
  for (const row of await db
    .select({ id: profiles.id, name: profiles.name })
    .from(profiles)) {
    profileNames.set(row.id, row.name);
  }

  const profileStats: StatsProfileRow[] = profileRows
    .map((row) => {
      // A null profile_id, or one naming a profile since deleted, both read as
      // unattributed — the column is insert-only and predates most rows.
      const name =
        row.profileId === null
          ? "Unattributed"
          : (profileNames.get(row.profileId) ?? "Deleted profile");
      return {
        profileId: row.profileId,
        name,
        jobs: row.jobs,
        goodFit: row.goodFit,
      };
    })
    .sort((a, b) => b.jobs - a.jobs || a.name.localeCompare(b.name));

  return {
    sources,
    profiles: profileStats,
    termAttributionAvailable: false,
    perRunYieldAvailable: false,
  };
}

/**
 * Applications: reply rate, reply time, and what is still outstanding.
 *
 * The bucket CASE partitions the applied set exactly. `movedOn` is the residual
 * and is deliberately rendered: reopening a closed job clears its outcome but
 * keeps `applied_at`, and skipping or sweeping a row does the same, so those
 * applications are real but no longer in an application state. Without the
 * bucket the parts would not sum to the whole.
 */
export async function getApplicationStats(
  query: StatsQuery,
): Promise<StatsApplications> {
  const where = applicationFilters(query);
  const staleCutoff = sql`datetime('now', ${`-${GHOSTED_AFTER_DAYS} days`})`;

  const bucket = sql<string>`case
    when ${jobs.status} = 'in_progress' then 'advanced'
    when ${jobs.outcome} = 'rejected' then 'rejected'
    when ${jobs.outcome} = 'ghosted' then 'ghosted_recorded'
    when ${jobs.outcome} is not null then 'closed_other'
    when ${jobs.status} = 'applied' and coalesce(datetime(${jobs.appliedAt}), '0001-01-01 00:00:00') < ${staleCutoff} then 'ghosted_derived'
    when ${jobs.status} = 'applied' then 'waiting'
    else 'moved_on'
  end`;

  const rows = await db
    .select({ bucket, count: sql<number>`count(*)` })
    .from(jobs)
    .where(where)
    .groupBy(bucket);

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.bucket, row.count);
  const get = (key: string) => counts.get(key) ?? 0;

  const rejected = get("rejected");
  const advanced = get("advanced");
  const applied = [...counts.values()].reduce((sum, n) => sum + n, 0);

  // Reply time is measurable only where a closure stamped `closed_at`. There is
  // no transition timestamp for a move to Interviewing (only `updated_at`,
  // which any edit bumps), so advances contribute no duration.
  //
  // The two julianday NULL tests are what catch a legacy millisecond-valued
  // `closed_at` — `datetime(..., 'unixepoch')` on it lands outside the range
  // SQLite can represent and returns NULL — while the `>= 0` test drops a row
  // closed before it was applied. The `closed_at is not null` clause ahead of
  // them is redundant against the NULL tests and kept only to let SQLite skip
  // the arithmetic on the many rows that were never closed.
  const durationRows = await db
    .select({
      days: sql<number>`julianday(datetime(${jobs.closedAt}, 'unixepoch')) - julianday(${jobs.appliedAt})`,
    })
    .from(jobs)
    .where(
      and(
        where,
        sql`${jobs.closedAt} is not null`,
        sql`julianday(datetime(${jobs.closedAt}, 'unixepoch')) is not null`,
        sql`julianday(${jobs.appliedAt}) is not null`,
        sql`julianday(datetime(${jobs.closedAt}, 'unixepoch')) - julianday(${jobs.appliedAt}) >= 0`,
      ),
    );

  const durations = durationRows
    .map((row) => Number(row.days))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  // Rounded to one decimal for every sample size. Branching the precision on
  // the parity of the sample would show a median of 6.4 as "6" from one
  // application and "6.4" from two.
  const medianReplyDays =
    durations.length === 0
      ? null
      : Math.round(
          (durations.length % 2 === 1
            ? (durations[(durations.length - 1) / 2] as number)
            : ((durations[durations.length / 2 - 1] as number) +
                (durations[durations.length / 2] as number)) /
              2) * 10,
        ) / 10;

  const replyTimeBuckets: StatsReplyTimeBucket[] = REPLY_TIME_BUCKETS.map(
    (definition) => ({
      key: definition.key,
      label:
        definition.maxDays === null
          ? `${definition.minDays}+`
          : `${definition.minDays}-${definition.maxDays}`,
      count: durations.filter(
        (value) =>
          value >= definition.minDays &&
          (definition.maxDays === null || value < definition.maxDays + 1),
      ).length,
    }),
  );

  // Everything still outstanding, oldest first — `stillWaiting` PLUS the
  // derived ghosts, which is deliberately wider than the `stillWaiting` count
  // beside it. Listing only the fresh ones would hide precisely the
  // applications worth chasing, and because the list is oldest-first it would
  // in practice show none of the rows the count refers to.
  //
  // The julianday guard drops a row whose `applied_at` cannot be parsed: NULLs
  // sort first in SQLite, so such a row would otherwise head the list claiming
  // it had been waiting zero days.
  const outstandingWhere = and(
    where,
    sql`${jobs.status} = 'applied'`,
    sql`${jobs.outcome} is null`,
    sql`julianday(${jobs.appliedAt}) is not null`,
  );

  const outstandingRows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      employer: jobs.employer,
      appliedAt: jobs.appliedAt,
      liveClosed: jobs.liveClosed,
      days: sql<number>`julianday('now') - julianday(${jobs.appliedAt})`,
    })
    .from(jobs)
    .where(outstandingWhere)
    .orderBy(sql`datetime(${jobs.appliedAt}) asc`)
    .limit(OUTSTANDING_LIMIT);

  const [outstandingCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(outstandingWhere);

  const outstanding: StatsOutstandingRow[] = outstandingRows.map((row) => ({
    id: row.id,
    title: row.title,
    employer: row.employer,
    appliedAt: row.appliedAt ?? "",
    daysWaiting: Math.max(0, Math.floor(Number(row.days))),
    liveClosed: row.liveClosed ?? null,
  }));

  return {
    applied,
    heardBack: rejected + advanced,
    rejected,
    advanced,
    ghostedRecorded: get("ghosted_recorded"),
    ghostedDerived: get("ghosted_derived"),
    stillWaiting: get("waiting"),
    closedOther: get("closed_other"),
    movedOn: get("moved_on"),
    medianReplyDays,
    replyTimeBuckets,
    replyTimeSampleSize: durations.length,
    outstanding,
    outstandingTotal: outstandingCount?.count ?? 0,
  };
}

/**
 * Company aggregates.
 *
 * Grouped on `lower(employer)` — EXACTLY the jobs list's own employer filter
 * (`repositories/jobs.ts`: `lower(employer) = lower(?)`), with no trimming, so a
 * row's count is precisely what clicking it opens. Adding a `trim()` here reads
 * like an improvement and is not: it merges spellings the filter still treats as
 * different, so the count would exceed the list every time. Whitespace variants
 * therefore stay separate rows, which is also the honest rendering of a scraper
 * emitting two spellings.
 *
 * Deliberately NOT `normalizeCompanyName` — that is the duplicate detection rule
 * and is far more aggressive, which would make the two surfaces disagree in the
 * other direction.
 */
export async function getCompanyStats(
  query: StatsQuery,
): Promise<StatsCompanies> {
  const where = discoveryFilters(query);
  const key = sql<string>`lower(${jobs.employer})`;

  const companyQuery = db
    .select({
      key,
      employer: sql<string>`max(${jobs.employer})`,
      jobs: sql<number>`count(*)`,
      goodFit: sql<number>`sum(case when ${goodFitSql} then 1 else 0 end)`,
      applied: sql<number>`sum(case when ${jobs.appliedAt} is not null then 1 else 0 end)`,
    })
    .from(jobs)
    .groupBy(key);
  const rows = where ? await companyQuery.where(where) : await companyQuery;

  const companies: StatsCompanyRow[] = rows
    .map((row) => ({
      key: row.key,
      employer: row.employer,
      jobs: row.jobs,
      goodFit: row.goodFit,
      applied: row.applied,
    }))
    .sort(
      (a, b) =>
        b.goodFit - a.goodFit ||
        b.jobs - a.jobs ||
        a.employer.localeCompare(b.employer),
    )
    .slice(0, COMPANY_LIMIT);

  const churnQuery = db
    .select({
      total: sql<number>`count(*)`,
      reposted: sql<number>`sum(case when ${jobs.repostCount} > 0 then 1 else 0 end)`,
      liveClosed: sql<number>`sum(case when ${jobs.liveClosed} = 1 then 1 else 0 end)`,
      liveChecked: sql<number>`sum(case when ${jobs.liveStatusCheckedAt} is not null then 1 else 0 end)`,
    })
    .from(jobs);
  const [churn] = where ? await churnQuery.where(where) : await churnQuery;

  return {
    companies,
    repostedJobs: churn?.reposted ?? 0,
    liveClosedJobs: churn?.liveClosed ?? 0,
    // Reported as a count, never as a share of totalJobs: only LinkedIn-shaped
    // rows are checkable at all, so a percentage would libel every other board.
    liveStatusChecked: churn?.liveChecked ?? 0,
    totalJobs: churn?.total ?? 0,
  };
}
