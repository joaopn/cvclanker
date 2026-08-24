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

const dateValue = (value: string | null) => {
  if (!value) return null;
  // Some extractors persist `date_posted` as a Unix-ms numeric string
  // (jobspy → linkedin/indeed) rather than ISO. Treat all-digit strings as ms.
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
    default:
      value = 0;
  }

  if (value !== 0) return sort.direction === "asc" ? value : -value;
  return a.id.localeCompare(b.id);
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
