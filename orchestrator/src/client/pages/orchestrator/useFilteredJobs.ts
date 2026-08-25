import type { JobListItem, JobSource } from "@shared/types";
import { useMemo } from "react";
import type {
  ClosedSubFilter,
  DateFilterDimension,
  FilterTab,
  FitFilterValue,
  JobDateFilter,
  JobSort,
  JobSorter,
  SalaryFilter,
} from "./constants";
import { JOB_SORTER_SORTS, UNATTRIBUTED_PROFILE_ID } from "./constants";
import { type ActiveFacet, buildFacetPredicates } from "./facets/registry";
import {
  compareJobs,
  getJobDateValue,
  getJobPostedValue,
  parseSalaryBounds,
} from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;

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
  // Search Profile ids and job-title terms picked from the badge rows. Both
  // OR within themselves and AND with every other filter. Empty = no
  // narrowing; the caller passes empty arrays on tabs that don't render the
  // rows, so neither can sit hidden-and-active.
  profileFilter: string[] = [],
  titleFilter: string[] = [],
  // Ids of the Search Profiles that still exist. A row attributed to a deleted
  // profile matches no badge, so it counts as unattributed — otherwise those
  // rows are reachable from no profile selection at all.
  knownProfileIds: string[] = [],
  // The filter bar's sorter icon. `none` = idle, and `sort` (the Filters
  // popover) governs; anything else pins the whole JobSort. The caller passes
  // `none` on tabs that don't render the bar, so it can't act unseen.
  sorter: JobSorter = "none",
) =>
  useMemo(() => {
    let filtered = [...jobs];

    if (activeTab === "inbox") {
      filtered = filtered.filter((job) => job.status === "discovered");
    } else if (activeTab === "tailoring") {
      // The Tailoring workspace holds everything committed to tailoring:
      // `processing` (pending / in-flight / failed-awaiting-retry) + `ready`
      // (done). The Untailored toggle narrows to the not-yet-tailored rows.
      filtered = filtered.filter(
        (job) => job.status === "processing" || job.status === "ready",
      );
      if (untailoredOnly) {
        filtered = filtered.filter((job) => job.status === "processing");
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

    // Search Profile badges. A row with no attribution (manual import, or
    // discovered before attribution shipped) matches only the explicit
    // "Unattributed" sentinel — the same shape as `unscored` in the fit
    // family, so those rows stay reachable.
    if (profileFilter.length > 0) {
      const set = new Set(profileFilter);
      const known = new Set(knownProfileIds);
      filtered = filtered.filter((job) => {
        // Unattributed covers both "never had a profile" and "had one that has
        // since been deleted" — in both cases no profile badge names the row.
        if (job.profileId == null || !known.has(job.profileId)) {
          return set.has(UNATTRIBUTED_PROFILE_ID);
        }
        return set.has(job.profileId);
      });
    }

    // Job-title badges: case-insensitive substring match of the profile search
    // terms against the job's title.
    if (titleFilter.length > 0) {
      const terms = titleFilter
        .map((term) => term.trim().toLowerCase())
        .filter(Boolean);
      if (terms.length > 0) {
        filtered = filtered.filter((job) => {
          const title = job.title.toLowerCase();
          return terms.some((term) => title.includes(term));
        });
      }
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

    const baseSort = sorter === "none" ? sort : JOB_SORTER_SORTS[sorter];
    const effectiveSort =
      baseSort.key === "date"
        ? { ...baseSort, datePriority: getDatePriority(dateFilter.dimensions) }
        : baseSort;

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
    profileFilter,
    titleFilter,
    knownProfileIds,
    sorter,
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
