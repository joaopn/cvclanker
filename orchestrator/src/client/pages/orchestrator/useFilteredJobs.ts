import type { JobListItem, JobSource } from "@shared/types";
import { useMemo } from "react";
import type {
  ClosedSubFilter,
  DateFilterDimension,
  FilterTab,
  FitFilterValue,
  JobDateFilter,
  JobSort,
  SalaryFilter,
} from "./constants";
import { type ActiveFacet, buildFacetPredicates } from "./facets/registry";
import {
  compareJobs,
  getJobDateValue,
  getJobPostedValue,
  parseSalaryBounds,
} from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;

// Statuses a job can be tailored *from* — i.e. it hasn't been through the
// tailoring funnel yet. Mirrors the server's MOVE_TO_READY_FROM_STATUSES.
const UNTAILORED_STATUSES = new Set<JobListItem["status"]>([
  "discovered",
  "backlog",
  "stale",
]);

const dateSortPriorityOrder: DateFilterDimension[] = [
  "ready",
  "applied",
  "closed",
  "discovered",
];

export const useFilteredJobs = (
  jobs: JobListItem[],
  activeTab: FilterTab,
  dateFilter: JobDateFilter,
  sourceFilter: JobSource | "all",
  salaryFilter: SalaryFilter,
  sort: JobSort,
  maxAgeDays: number | null,
  closedSubFilter: ClosedSubFilter,
  fitFilter: FitFilterValue[],
  untailoredOnly: boolean,
  activeFacets: ActiveFacet[] = [],
) =>
  useMemo(() => {
    let filtered = [...jobs];

    if (untailoredOnly) {
      filtered = filtered.filter((job) => UNTAILORED_STATUSES.has(job.status));
    }

    if (activeTab === "inbox") {
      filtered = filtered.filter((job) => job.status === "discovered");
    } else if (activeTab === "tailoring") {
      // Workspace tab. With the Untailored toggle on, the global filter above
      // has already narrowed to candidates that still need tailoring; leave
      // those visible so they can be bulk-selected and tailored. Off, show the
      // in-flight (processing) + finished (ready) rows.
      if (!untailoredOnly) {
        filtered = filtered.filter(
          (job) => job.status === "processing" || job.status === "ready",
        );
      }
    } else if (activeTab === "live") {
      filtered = filtered.filter((job) => job.status === "applied");
    } else if (activeTab === "interviewing") {
      filtered = filtered.filter((job) => job.status === "in_progress");
    } else if (activeTab === "backlog") {
      filtered = filtered.filter((job) => job.status === "backlog");
    } else if (activeTab === "stale") {
      filtered = filtered.filter((job) => job.status === "stale");
    } else if (activeTab === "closed") {
      filtered = filtered.filter(
        (job) => job.status === "skipped" || job.status === "closed",
      );
      if (closedSubFilter !== "all") {
        if (closedSubFilter === "skipped") {
          filtered = filtered.filter((job) => job.status === "skipped");
        } else {
          filtered = filtered.filter(
            (job) =>
              job.status === "closed" && job.outcome === closedSubFilter,
          );
        }
      }
    } else if (activeTab === "all") {
      const includeClosedJobs = dateFilter.dimensions.includes("closed");
      if (!includeClosedJobs) {
        filtered = filtered.filter(
          (job) =>
            job.status !== "skipped" &&
            job.status !== "closed" &&
            job.status !== "stale",
        );
      }
    }

    if (dateFilter.dimensions.length > 0) {
      filtered = filtered.filter((job) =>
        dateFilter.dimensions.some((dimension) =>
          matchesDateDimension(job, dimension, dateFilter),
        ),
      );
    }

    if (sourceFilter !== "all") {
      filtered = filtered.filter((job) => job.source === sourceFilter);
    }

    if (fitFilter.length > 0) {
      const set = new Set(fitFilter);
      filtered = filtered.filter((job) => {
        if (job.suitabilityCategory == null) return set.has("unscored");
        return set.has(job.suitabilityCategory);
      });
    }

    // Ephemeral facet filters (Company / Title / Location / …). Each active
    // facet contributes an independent predicate, AND'd together.
    if (activeFacets.length > 0) {
      for (const predicate of buildFacetPredicates(activeFacets)) {
        filtered = filtered.filter(predicate);
      }
    }

    if (maxAgeDays != null && maxAgeDays > 0) {
      const cutoff = Date.now() - maxAgeDays * DAY_MS;
      filtered = filtered.filter((job) => {
        const posted = getJobPostedValue(job);
        if (posted == null) return false;
        return posted >= cutoff;
      });
    }

    const hasMin =
      typeof salaryFilter.min === "number" &&
      Number.isFinite(salaryFilter.min) &&
      salaryFilter.min > 0;
    const hasMax =
      typeof salaryFilter.max === "number" &&
      Number.isFinite(salaryFilter.max) &&
      salaryFilter.max > 0;

    if (
      (salaryFilter.mode === "at_least" && hasMin) ||
      (salaryFilter.mode === "at_most" && hasMax) ||
      (salaryFilter.mode === "between" && (hasMin || hasMax))
    ) {
      filtered = filtered.filter((job) => {
        const bounds = parseSalaryBounds(job);
        if (!bounds) return false;

        if (salaryFilter.mode === "at_least") {
          return hasMin ? bounds.max >= (salaryFilter.min as number) : true;
        }

        if (salaryFilter.mode === "at_most") {
          return hasMax ? bounds.min <= (salaryFilter.max as number) : true;
        }

        const min = hasMin ? (salaryFilter.min as number) : null;
        const max = hasMax ? (salaryFilter.max as number) : null;

        if (min != null && max != null) {
          return bounds.max >= min && bounds.min <= max;
        }
        if (min != null) return bounds.max >= min;
        if (max != null) return bounds.min <= max;
        return true;
      });
    }

    const effectiveSort =
      sort.key === "date"
        ? { ...sort, datePriority: getDatePriority(dateFilter.dimensions) }
        : sort;

    return [...filtered].sort((a, b) => compareJobs(a, b, effectiveSort));
  }, [
    jobs,
    activeTab,
    dateFilter,
    sourceFilter,
    salaryFilter,
    sort,
    maxAgeDays,
    closedSubFilter,
    fitFilter,
    untailoredOnly,
    activeFacets,
  ]);

const matchesDateDimension = (
  job: JobListItem,
  dimension: DateFilterDimension,
  filter: JobDateFilter,
): boolean => {
  const value = getJobDateValue(job, dimension);
  if (value == null) return false;

  const localDate = toLocalDateKey(value);
  if (!localDate) return false;

  if (filter.startDate && localDate < filter.startDate) return false;
  if (filter.endDate && localDate > filter.endDate) return false;
  return true;
};

const getDatePriority = (dimensions: DateFilterDimension[]) => {
  const enabled = dateSortPriorityOrder.filter((dimension) =>
    dimensions.includes(dimension),
  );
  return enabled.length > 0 ? enabled : dateSortPriorityOrder;
};

const toLocalDateKey = (value: number): string | null => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
