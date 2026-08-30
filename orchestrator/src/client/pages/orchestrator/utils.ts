import {
  type AppSettings,
  type JobListItem,
  type JobSource,
  type JobStatus,
  type Profile,
  SUITABILITY_CATEGORY_RANK,
} from "@shared/types";
import type { DateFilterDimension, FilterTab, JobSort } from "./constants";
import { orderedFilterSources, orderedSources } from "./constants";
import { hasLinkedinPostingId } from "./jobActions";

/**
 * Best-effort ms timestamp for a stored date. Some extractors persist
 * `date_posted` as a Unix-ms numeric string (jobspy → linkedin/indeed) rather
 * than ISO, so all-digit strings are read as ms. The one date reader the job
 * surfaces share.
 */
export const dateValue = (value: string | null | undefined) => {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const compareString = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "base" });
const compareNumber = (a: number, b: number) => a - b;

export const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

// The job-title badges are the union of every Search Profile's search terms,
// deduped case-insensitively (first spelling wins) and sorted so the row is
// stable as profiles are edited. Shared by the Manage filter bar and the
// Swipe filter sheet.
export const collectProfileSearchTitles = (profiles: Profile[]): string[] => {
  const byKey = new Map<string, string>();
  for (const profile of profiles) {
    for (const term of profile.config.searchTerms) {
      const trimmed = term.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, trimmed);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
};

export const parseSalaryBounds = (
  job: JobListItem,
): { min: number; max: number } | null => {
  if (
    typeof job.salaryMinAmount === "number" &&
    Number.isFinite(job.salaryMinAmount)
  ) {
    if (
      typeof job.salaryMaxAmount === "number" &&
      Number.isFinite(job.salaryMaxAmount)
    ) {
      return { min: job.salaryMinAmount, max: job.salaryMaxAmount };
    }
    return { min: job.salaryMinAmount, max: job.salaryMinAmount };
  }
  if (
    typeof job.salaryMaxAmount === "number" &&
    Number.isFinite(job.salaryMaxAmount)
  ) {
    return { min: job.salaryMaxAmount, max: job.salaryMaxAmount };
  }
  if (!job.salary) return null;

  const normalized = job.salary.toLowerCase().replace(/,/g, "");
  const values: number[] = [];

  const kPattern = /(\d+(?:\.\d+)?)\s*k\b/g;
  for (const match of normalized.matchAll(kPattern)) {
    values.push(Math.round(Number.parseFloat(match[1]) * 1000));
  }

  const plainPattern = /(\d{4,6}(?:\.\d+)?)/g;
  for (const match of normalized.matchAll(plainPattern)) {
    values.push(Math.round(Number.parseFloat(match[1])));
  }

  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
};

/**
 * Reads LinkedIn's applicant caption as stored by the live-status action into
 * a number the "fewer applicants" sort can order on. The captions are
 * LinkedIn's own text, whitespace-collapsed and otherwise verbatim: measured
 * "45 applicants" and "Be among the first 25 applicants", plus the documented
 * cap "Over 200 applicants". Every branch keys on the "applicants" tail so a
 * caption about anything else reads as no count.
 *
 * - "Over N" (and the "N+" spelling of the same cap) means more than N, i.e.
 *   at least N + 1 — which keeps it after an explicit N.
 * - "Be among the first N" is shown INSTEAD of any count below N, so nothing
 *   explicit competes with it; 0 puts it where fewest-first wants it.
 * - Anything unreadable is null: the row then has no count, not a guessed one.
 */
export const parseLiveApplicants = (caption: string | null): number | null => {
  if (!caption) return null;
  const text = caption.trim().toLowerCase();
  if (!text) return null;

  const over = /\bover\s+(\d[\d,]*)\s*applicants?\b/.exec(text);
  if (over) return toCount(over[1]) + 1;

  const first = /\bfirst\s+(\d[\d,]*)\s*applicants?\b/.exec(text);
  if (first) return 0;

  const plain = /(\d[\d,]*)\s*(\+)?\s*applicants?\b/.exec(text);
  if (plain) return toCount(plain[1]) + (plain[2] ? 1 : 0);

  return null;
};

const toCount = (digits: string) =>
  Number.parseInt(digits.replace(/,/g, ""), 10);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long ago the live-status action last read the posting, as the Manage
 * row and the Swipe card both label it. Null when the row was never checked.
 */
export const formatCheckedAge = (
  checkedAt: string | null,
  now: number,
): string | null => {
  const checked = dateValue(checkedAt);
  if (checked == null) return null;
  const days = Math.max(0, Math.floor((now - checked) / DAY_MS));
  return days === 0 ? "checked today" : `checked ${days}d ago`;
};

/**
 * Where a row lands under the applicants sort. Tier 0 is the only one with a
 * count; the rest are the rows that have none, ordered so that a row that
 * could still be checked (never checked, or checked open with no caption)
 * sits above a dead one, and everything not on LinkedIn — which the
 * live-status action can never read — forms the floor. Membership follows
 * the DATA, not the URL shape: a closed verdict or a count on the row is
 * taken before asking whether the URL looks like a LinkedIn posting.
 */
export type ApplicantsSortRank =
  | { tier: 0; count: number }
  | { tier: 1 | 2 | 3; count: null };
export const applicantsSortRank = (job: JobListItem): ApplicantsSortRank => {
  if (job.liveClosed === true) return { tier: 2, count: null };
  const count = parseLiveApplicants(job.liveApplicants);
  if (count != null) return { tier: 0, count };
  if (!hasLinkedinPostingId(job)) return { tier: 3, count: null };
  return { tier: 1, count: null };
};

// Newest posted / found first; a row with no date at all goes last. (Today
// every row has one — `discoveredAt` is NOT NULL — so the null arms only pin
// the intent for the next copy of this pattern.)
const comparePostedNewestFirst = (a: JobListItem, b: JobListItem) => {
  const aPosted = getJobPostedValue(a);
  const bPosted = getJobPostedValue(b);
  if (aPosted == null && bPosted == null) return 0;
  if (aPosted == null) return 1;
  if (bPosted == null) return -1;
  return compareNumber(bPosted, aPosted);
};

export const compareJobs = (a: JobListItem, b: JobListItem, sort: JobSort) => {
  let value = 0;

  switch (sort.key) {
    case "title":
      value = compareString(a.title, b.title);
      break;
    case "employer":
      value = compareString(a.employer, b.employer);
      break;
    case "score": {
      const aCategory = a.suitabilityCategory;
      const bCategory = b.suitabilityCategory;

      if (aCategory == null && bCategory == null) {
        value = 0;
        break;
      }
      if (aCategory == null) return 1;
      if (bCategory == null) return -1;
      value = compareNumber(
        SUITABILITY_CATEGORY_RANK[aCategory],
        SUITABILITY_CATEGORY_RANK[bCategory],
      );
      break;
    }
    case "salary": {
      const aSalary = parseSalaryBounds(a);
      const bSalary = parseSalaryBounds(b);
      if (aSalary == null && bSalary == null) {
        value = 0;
        break;
      }
      if (aSalary == null) return 1;
      if (bSalary == null) return -1;
      value = compareNumber(aSalary.max, bSalary.max);
      if (value === 0) {
        value = compareNumber(aSalary.min, bSalary.min);
      }
      break;
    }
    case "discoveredAt": {
      const aDate = dateValue(a.discoveredAt);
      const bDate = dateValue(b.discoveredAt);
      if (aDate == null && bDate == null) {
        value = 0;
        break;
      }
      if (aDate == null) return 1;
      if (bDate == null) return -1;
      value = compareNumber(aDate, bDate);
      break;
    }
    case "posted": {
      const aDate = getJobPostedValue(a);
      const bDate = getJobPostedValue(b);
      if (aDate == null && bDate == null) {
        value = 0;
        break;
      }
      if (aDate == null) return 1;
      if (bDate == null) return -1;
      value = compareNumber(aDate, bDate);
      break;
    }
    case "date": {
      const aDate = getSortDateValue(a, sort);
      const bDate = getSortDateValue(b, sort);
      if (aDate == null && bDate == null) {
        value = 0;
        break;
      }
      if (aDate == null) return 1;
      if (bDate == null) return -1;
      value = compareNumber(aDate, bDate);
      break;
    }
    case "applicants": {
      const aRank = applicantsSortRank(a);
      const bRank = applicantsSortRank(b);
      // Tiers hold whatever the direction — same shape as the null-last rule
      // of `score` / `salary`: flipping "fewest first" to "most first" must not
      // hoist the rows that have no count at all.
      if (aRank.tier !== bRank.tier) return aRank.tier - bRank.tier;
      if (aRank.tier === 0 && bRank.tier === 0) {
        value = compareNumber(aRank.count, bRank.count);
      }
      if (value === 0) {
        // Equal counts, and every row of the count-less tiers: newest
        // posted / found first, whatever the direction. The id fallback below
        // would make those tiers look shuffled.
        const byPosted = comparePostedNewestFirst(a, b);
        if (byPosted !== 0) return byPosted;
      }
      break;
    }
    default:
      value = 0;
  }

  if (value !== 0) return sort.direction === "asc" ? value : -value;
  return a.id.localeCompare(b.id);
};

/**
 * Tooltip for the permanent applied badge. Deliberately date-only: for a row
 * stamped by the boot backfill the value is derived from `ready_at`/`closed_at`
 * rather than observed, so rendering a raw ISO instant to the millisecond would
 * present an estimate as a measurement.
 */
export const appliedBadgeTitle = (appliedAt: string | null): string => {
  const value = dateValue(appliedAt);
  if (value == null) return "Applied";
  return `Applied ${new Date(value).toLocaleDateString()}`;
};

export const getJobPostedValue = (job: JobListItem): number | null =>
  dateValue(job.datePosted) ?? dateValue(job.discoveredAt);

export const getJobDateValue = (
  job: JobListItem,
  dimension: DateFilterDimension,
): number | null => {
  switch (dimension) {
    case "ready":
      return dateValue(job.readyAt);
    case "applied":
      return dateValue(job.appliedAt);
    case "closed":
      return typeof job.closedAt === "number" ? job.closedAt * 1000 : null;
    case "discovered":
      return dateValue(job.discoveredAt);
  }
};

const getSortDateValue = (job: JobListItem, sort: JobSort): number | null => {
  for (const dimension of sort.datePriority ?? []) {
    const value = getJobDateValue(job, dimension);
    if (value != null) return value;
  }

  return dateValue(job.discoveredAt);
};

export const jobMatchesQuery = (job: JobListItem, query: string) => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [
    job.title,
    job.employer,
    job.location,
    job.source,
    job.status,
    job.jobType,
    job.jobFunction,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(normalized);
};

/**
 * Tab badge counts from the server's global by-status stats. Derived from
 * stats rather than from the loaded rows because the list payload is scoped
 * to the active tab — counting rows would zero every other tab's badge.
 * Includes a `discovered` alias so legacy callers (empty-state CTAs that ask
 * "how many Inbox rows" via the historical `counts.discovered` name) keep
 * working without churn.
 */
export const getJobCountsFromStats = (
  byStatus: Record<JobStatus, number>,
): Record<FilterTab, number> & { discovered: number } => {
  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  return {
    inbox: byStatus.discovered,
    tailoring: byStatus.processing + byStatus.ready,
    live: byStatus.applied,
    interviewing: byStatus.in_progress,
    backlog: byStatus.backlog,
    stale: byStatus.stale,
    closed: byStatus.skipped + byStatus.closed,
    // A stray legacy `selected` row counts only here, as before.
    all: total,
    discovered: byStatus.discovered,
  };
};

export const getSourcesWithJobs = (jobs: JobListItem[]): JobSource[] => {
  const seen = new Set<JobSource>();
  for (const job of jobs) {
    seen.add(job.source);
  }
  return orderedFilterSources.filter((source) => seen.has(source));
};

export const getEnabledSources = (
  _settings: AppSettings | null,
): JobSource[] => [...orderedSources];
