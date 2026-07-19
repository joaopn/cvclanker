import {
  EXTRACTOR_SOURCE_IDS,
  EXTRACTOR_SOURCE_METADATA,
  type ExtractorSourceId,
  PIPELINE_EXTRACTOR_SOURCE_IDS,
} from "@shared/extractors";
import {
  type JobOutcome,
  type JobStatus,
  SUITABILITY_CATEGORIES,
  SUITABILITY_CATEGORY_LABELS,
} from "@shared/types";

export const FIT_FILTER_VALUES = [
  ...SUITABILITY_CATEGORIES,
  "unscored",
] as const;
export type FitFilterValue = (typeof FIT_FILTER_VALUES)[number];
export const FIT_FILTER_LABELS: Record<FitFilterValue, string> = {
  ...SUITABILITY_CATEGORY_LABELS,
  unscored: "Unscored",
};

/**
 * Per-category classes for the inline fit-filter chip buttons.
 * The first entry is for the active (selected) state — saturated background
 * + readable text + matching border. The second is for the inactive state
 * — subtle text colour, ghost background, hover lift.
 */
export const FIT_FILTER_CHIP_CLASS: Record<
  FitFilterValue,
  { active: string; inactive: string }
> = {
  very_good_fit: {
    active:
      "bg-status-good/20 text-status-good-text border border-status-good/40 hover:bg-status-good/25",
    inactive:
      "text-status-good-text/80 hover:bg-status-good/10 hover:text-status-good-text border border-transparent",
  },
  good_fit: {
    active:
      "bg-status-info/20 text-status-info-text border border-status-info/40 hover:bg-status-info/25",
    inactive:
      "text-status-info-text/80 hover:bg-status-info/10 hover:text-status-info-text border border-transparent",
  },
  bad_fit: {
    active:
      "bg-muted/60 text-foreground border border-border hover:bg-muted/70",
    inactive:
      "text-muted-foreground hover:bg-muted/40 hover:text-foreground border border-transparent",
  },
  unscored: {
    active:
      "bg-status-warn/20 text-status-warn-text border border-status-warn/40 hover:bg-status-warn/25",
    inactive:
      "text-status-warn-text/80 hover:bg-status-warn/10 hover:text-status-warn-text border border-transparent",
  },
};

export const orderedSources: ExtractorSourceId[] = [
  ...PIPELINE_EXTRACTOR_SOURCE_IDS,
].sort(
  (left, right) =>
    EXTRACTOR_SOURCE_METADATA[left].order -
    EXTRACTOR_SOURCE_METADATA[right].order,
);
export const orderedFilterSources: ExtractorSourceId[] = [
  ...EXTRACTOR_SOURCE_IDS,
].sort(
  (left, right) =>
    EXTRACTOR_SOURCE_METADATA[left].order -
    EXTRACTOR_SOURCE_METADATA[right].order,
);

export const statusTokens: Record<
  JobStatus,
  { label: string; badge: string; dot: string }
> = {
  discovered: {
    label: "Discovered",
    badge: "border-status-info/30 bg-status-info/10 text-status-info-text",
    dot: "bg-status-info",
  },
  selected: {
    label: "Selected",
    badge:
      "border-accent-purple/30 bg-accent-purple/10 text-accent-purple-text",
    dot: "bg-accent-purple",
  },
  processing: {
    label: "Processing",
    badge: "border-status-warn/30 bg-status-warn/10 text-status-warn-text",
    dot: "bg-status-warn",
  },
  ready: {
    label: "Ready",
    badge: "border-status-good/30 bg-status-good/10 text-status-good-text",
    dot: "bg-status-good",
  },
  applied: {
    label: "Applied",
    badge: "border-status-good/30 bg-status-good/10 text-status-good-text",
    dot: "bg-status-good",
  },
  in_progress: {
    label: "Interviewing",
    badge: "border-accent-cyan/30 bg-accent-cyan/10 text-accent-cyan-text",
    dot: "bg-accent-cyan",
  },
  backlog: {
    label: "Backlog",
    badge: "border-muted-foreground/20 bg-muted/30 text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  stale: {
    label: "Stale",
    badge: "border-muted-foreground/20 bg-muted/30 text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  skipped: {
    label: "Skipped",
    badge: "border-status-bad/30 bg-status-bad/10 text-status-bad-text",
    dot: "bg-status-bad",
  },
  closed: {
    label: "Closed",
    badge: "border-muted-foreground/20 bg-muted/30 text-muted-foreground",
    dot: "bg-muted-foreground",
  },
};

export const defaultStatusToken = {
  label: "Unknown",
  badge: "border-muted-foreground/20 bg-muted/30 text-muted-foreground",
  dot: "bg-muted-foreground",
};

export const outcomeLabel: Record<JobOutcome, string> = {
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  ghosted: "Ghosted",
  duplicated: "Duplicated",
  other: "Other",
};

export const appliedDuplicateIndicator = {
  label: "Previously Applied",
  dot: "bg-status-warn",
};

export type FilterTab =
  | "inbox"
  | "tailoring"
  | "live"
  | "interviewing"
  | "backlog"
  | "stale"
  | "closed"
  | "all";
export type DateFilterPreset = "7" | "14" | "30" | "90" | "custom";
export type DateFilterDimension = "ready" | "applied" | "closed" | "discovered";

export type SortKey =
  | "date"
  | "discoveredAt"
  | "posted"
  | "score"
  | "salary"
  | "title"
  | "employer";
export type SortDirection = "asc" | "desc";
export type SponsorFilter =
  | "all"
  | "confirmed"
  | "potential"
  | "not_found"
  | "unknown";
export type SalaryFilterMode = "at_least" | "at_most" | "between";

export interface SalaryFilter {
  mode: SalaryFilterMode;
  min: number | null;
  max: number | null;
}

export interface JobSort {
  key: SortKey;
  direction: SortDirection;
  datePriority?: DateFilterDimension[];
}

export interface JobDateFilter {
  dimensions: DateFilterDimension[];
  startDate: string | null;
  endDate: string | null;
  preset: DateFilterPreset | null;
}

export const DEFAULT_SORT: JobSort = { key: "posted", direction: "desc" };
export const DEFAULT_DATE_FILTER: JobDateFilter = {
  dimensions: [],
  startDate: null,
  endDate: null,
  preset: null,
};

export const sortLabels: Record<JobSort["key"], string> = {
  date: "Date",
  discoveredAt: "Discovered",
  posted: "Posted",
  score: "Fit",
  salary: "Salary",
  title: "Title",
  employer: "Company",
};

export const defaultSortDirection: Record<JobSort["key"], SortDirection> = {
  date: "desc",
  discoveredAt: "desc",
  posted: "desc",
  score: "desc",
  salary: "desc",
  title: "asc",
  employer: "asc",
};

export type ClosedSubFilter =
  | "all"
  | "skipped"
  | "rejected"
  | "withdrawn"
  | "ghosted"
  | "duplicated"
  | "other";

export const ALLOWED_CLOSED_SUB_FILTERS: ClosedSubFilter[] = [
  "all",
  "skipped",
  "rejected",
  "withdrawn",
  "ghosted",
  "duplicated",
  "other",
];

export const tabs: Array<{
  id: FilterTab;
  label: string;
  statuses: JobStatus[];
}> = [
  { id: "inbox", label: "Inbox", statuses: ["discovered"] },
  {
    id: "tailoring",
    label: "Tailoring",
    statuses: ["processing", "ready"],
  },
  { id: "live", label: "Live", statuses: ["applied"] },
  { id: "interviewing", label: "Interviewing", statuses: ["in_progress"] },
  { id: "backlog", label: "Backlog", statuses: ["backlog"] },
  { id: "stale", label: "Stale", statuses: ["stale"] },
  { id: "closed", label: "Closed", statuses: ["skipped", "closed"] },
  { id: "all", label: "All Jobs", statuses: [] },
];

export const emptyStateCopy: Record<FilterTab, string> = {
  inbox: "Run the pipeline to discover new jobs.",
  tailoring:
    "Nothing in tailoring yet. Select Inbox rows and click Tailor — they land here while their CV/cover letter generate, then turn Ready.",
  live: "Applied jobs awaiting a response land here. Mark a Ready row as Applied to start tracking. Move ones you're interviewing for to Interviewing.",
  interviewing:
    "Jobs you're actively interviewing for. Move an applied job here from the Live tab to track interview notes separately.",
  backlog:
    "Empty. Inbox rows that age past the threshold land here automatically; reposted listings get re-promoted.",
  stale:
    'Empty. Set an age threshold above and click "Move stale rows here" to sweep aged Inbox and Backlog rows into this holding pen — or "Also move aged Ready & Live here" to include those tabs.',
  closed:
    "Empty. Skipped jobs and Live rows you Mark Closed land here with an outcome chip.",
  all: "No jobs in the system yet. Run the pipeline to get started.",
};

export const dateFilterDimensionLabels: Record<DateFilterDimension, string> = {
  ready: "Ready",
  applied: "Applied",
  closed: "Closed",
  discovered: "Discovered",
};

export const dateFilterDimensionOrder: DateFilterDimension[] = [
  "ready",
  "applied",
  "closed",
  "discovered",
];
