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
  great_fit: {
    active:
      "bg-[color-mix(in_oklab,var(--badge-base)_75%,var(--badge-purple))] text-violet-200 border border-[color:color-mix(in_oklab,var(--badge-base)_55%,var(--badge-purple))] hover:bg-[color-mix(in_oklab,var(--badge-base)_70%,var(--badge-purple))]",
    inactive:
      "text-[#a78bfa] hover:bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-purple))] hover:text-violet-200 border border-transparent",
  },
  very_good_fit: {
    active:
      "bg-[color-mix(in_oklab,var(--badge-base)_80%,var(--badge-good))] text-emerald-200 border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-good))] hover:bg-[color-mix(in_oklab,var(--badge-base)_75%,var(--badge-good))]",
    inactive:
      "text-[#5bc6a1] hover:bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-good))] hover:text-emerald-200 border border-transparent",
  },
  good_fit: {
    active:
      "bg-[color-mix(in_oklab,var(--badge-base)_80%,var(--badge-info))] text-sky-200 border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-info))] hover:bg-[color-mix(in_oklab,var(--badge-base)_75%,var(--badge-info))]",
    inactive:
      "text-[#6ab5db] hover:bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-info))] hover:text-sky-200 border border-transparent",
  },
  bad_fit: {
    active:
      "bg-[color-mix(in_oklab,var(--badge-base)_40%,var(--badge-muted))] text-[#eceff4] border border-[color:var(--badge-muted)] hover:bg-[color-mix(in_oklab,var(--badge-base)_30%,var(--badge-muted))]",
    inactive:
      "text-[#d8dee9] hover:bg-[color-mix(in_oklab,var(--badge-base)_60%,var(--badge-muted))] hover:text-[#eceff4] border border-transparent",
  },
  unscored: {
    active:
      "bg-[color-mix(in_oklab,var(--badge-base)_80%,var(--badge-warn))] text-amber-200 border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-warn))] hover:bg-[color-mix(in_oklab,var(--badge-base)_75%,var(--badge-warn))]",
    inactive:
      "text-[#d5b449] hover:bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-warn))] hover:text-amber-200 border border-transparent",
  },
};

/**
 * The badge-filter families the Manage view can show. Each is switched on by
 * its own tickbox on the filter bar's control row (the row that also carries
 * the "+ Filter" button); the enabled families render one badge row each, in
 * this order. Only `fit` is on by default, which reproduces the behaviour
 * that predates the tickboxes.
 */
export const JOB_FILTER_CHIP_TYPES = ["fit", "profile", "title"] as const;
export type JobFilterChipType = (typeof JOB_FILTER_CHIP_TYPES)[number];

export const JOB_FILTER_CHIP_LABELS: Record<JobFilterChipType, string> = {
  fit: "Fit",
  profile: "Profile",
  title: "Job title",
};

export const DEFAULT_JOB_FILTER_CHIP_TYPES: readonly JobFilterChipType[] = [
  "fit",
];

/**
 * Sentinel profile-badge value matching rows with no attribution: manual
 * imports, and everything discovered before the profile column existed. Same
 * shape as `unscored` in the fit family — without it, an install's entire
 * pre-existing backlog is unreachable from this filter, since a NULL
 * `profileId` matches no real profile.
 */
export const UNATTRIBUTED_PROFILE_ID = "__unattributed__";
export const UNATTRIBUTED_PROFILE_LABEL = "Unattributed";

/**
 * Profile and job-title badges each carry ONE hardcoded colour for the whole
 * family — unlike the fit chips, whose colour encodes the category. Same
 * opaque color-mix construction as `statusTokens` / `FIT_FILTER_CHIP_CLASS`:
 * a fixed hue flattened over the per-theme `--badge-base`, never a translucent
 * tint and never a semantic token.
 *
 * Both hues are ones no status or fit chip already owns, so a badge in this
 * bar can't be misread as a status: teal is free (cyan belongs to
 * `in_progress`), and pink is new. Pick from the unclaimed hues if a third
 * family is ever added.
 */
export const PROFILE_FILTER_CHIP_CLASS = {
  active:
    "bg-[color-mix(in_oklab,var(--badge-base)_80%,var(--badge-teal))] text-teal-200 border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-teal))] hover:bg-[color-mix(in_oklab,var(--badge-base)_75%,var(--badge-teal))]",
  inactive:
    "text-[#2dd4bf] hover:bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-teal))] hover:text-teal-200 border border-transparent",
};

export const TITLE_FILTER_CHIP_CLASS = {
  active:
    "bg-[color-mix(in_oklab,var(--badge-base)_80%,var(--badge-pink))] text-pink-200 border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-pink))] hover:bg-[color-mix(in_oklab,var(--badge-base)_75%,var(--badge-pink))]",
  inactive:
    "text-[#f472b6] hover:bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-pink))] hover:text-pink-200 border border-transparent",
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

// Opaque badge colors. The HUE is theme-independent (fixed Tailwind -500
// values in --badge-* , src/index.css) so a status keeps one identity across
// every palette; only --badge-base, the surface the tint is flattened over, is
// per-theme, which is what keeps a chip sitting flush on its card instead of
// floating as a differently-toned rectangle. Chips stay opaque — never swap
// these back to translucent /NN tints or to the semantic -text tokens, both of
// which desaturate against the card. Vivid text stays on the fixed Tailwind
// palette and is deliberately NOT re-based.
export const statusTokens: Record<
  JobStatus,
  { label: string; badge: string; dot: string }
> = {
  discovered: {
    label: "Discovered",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-info))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-info))] text-sky-200",
    dot: "bg-sky-400",
  },
  selected: {
    label: "Selected",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-purple))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-purple))] text-violet-200",
    dot: "bg-violet-400",
  },
  processing: {
    label: "Processing",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-warn))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-warn))] text-amber-200",
    dot: "bg-amber-400",
  },
  ready: {
    label: "Ready",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-good))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-good))] text-emerald-200",
    dot: "bg-emerald-400",
  },
  applied: {
    label: "Applied",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-good))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-good))] text-emerald-200",
    dot: "bg-emerald-400",
  },
  in_progress: {
    label: "Interviewing",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-cyan))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-cyan))] text-cyan-200",
    dot: "bg-cyan-400",
  },
  backlog: {
    label: "Backlog",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_80%,var(--badge-muted-fg))] bg-[color-mix(in_oklab,var(--badge-base)_70%,var(--badge-muted))] text-[#d8dee9]",
    dot: "bg-muted-foreground",
  },
  stale: {
    label: "Stale",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-neutral))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-neutral))] text-stone-200",
    dot: "bg-stone-400",
  },
  skipped: {
    label: "Skipped",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-bad))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-bad))] text-rose-200",
    dot: "bg-rose-400",
  },
  closed: {
    label: "Closed",
    badge:
      "border-[color:color-mix(in_oklab,var(--badge-base)_80%,var(--badge-muted-fg))] bg-[color-mix(in_oklab,var(--badge-base)_70%,var(--badge-muted))] text-[#d8dee9]",
    dot: "bg-muted-foreground",
  },
};

export const defaultStatusToken = {
  label: "Unknown",
  badge:
    "border-[color:color-mix(in_oklab,var(--badge-base)_80%,var(--badge-muted-fg))] bg-[color-mix(in_oklab,var(--badge-base)_70%,var(--badge-muted))] text-[#d8dee9]",
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
  | "employer"
  | "applicants";
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

/**
 * The list sorter: the icon menu at the right end of the filter bar's control
 * row. It is a layer OVER the Filters-popover `sort` — `none` (the default)
 * means the sorter is idle and that sort governs, which is exactly the
 * pre-sorter behaviour; the other two pin a whole `JobSort`. A separate value
 * rather than a face for `sort` because `DEFAULT_SORT` IS posted-desc, so
 * "none" and "posted / found" would be one indistinguishable state there.
 */
export const JOB_SORTERS = ["none", "posted", "applicants"] as const;
export type JobSorter = (typeof JOB_SORTERS)[number];
export const DEFAULT_JOB_SORTER: JobSorter = "none";

export const JOB_SORTER_LABELS: Record<JobSorter, string> = {
  none: "None",
  posted: "Posted / found",
  applicants: "Fewer applicants",
};

// `posted` is the value behind the row's "Posted Xd / Found Xd" pill
// (`getJobPostedValue`: datePosted, else discoveredAt). `applicants` is the
// live-status count, fewest first — see `compareJobs` for the tiers that
// order the rows without one.
export const JOB_SORTER_SORTS: Record<Exclude<JobSorter, "none">, JobSort> = {
  posted: { key: "posted", direction: "desc" },
  applicants: { key: "applicants", direction: "asc" },
};
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
  applicants: "Applicants",
};

export const defaultSortDirection: Record<JobSort["key"], SortDirection> = {
  date: "desc",
  discoveredAt: "desc",
  posted: "desc",
  score: "desc",
  salary: "desc",
  title: "asc",
  employer: "asc",
  applicants: "asc",
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

// Tabs that surface the ephemeral facet-filter bar (Company / Title / Location
// / …). These are the untailored-candidate shelves plus All — the views where
// narrowing feeds bulk-select → Tailor. The facet filter is applied ONLY on
// these tabs, so it can never sit hidden-and-active on a tab whose header
// doesn't render the bar (the B2 trap).
export const FACET_TABS: FilterTab[] = ["inbox", "backlog", "stale", "all"];

// Tabs that surface the fit-tag filter chips. The fit predicate itself is
// still applied GLOBALLY in useFilteredJobs — unlike the profile and job-title
// families, it is not co-gated — so these are only the tabs where the chips
// are visible and clearable. (Moved here from JobListPanel when the chips
// became one family among several on the shared filter bar.)
//
// `all` joined the list with the filter bar: the bar advertises itself as the
// place your filters live, so a tab that renders it while fit narrows the list
// from nowhere reads as a bug. `closed` renders no bar at all and is therefore
// the one tab left where an active `?fit=` narrows invisibly; its empty state
// still offers the "Clear fit filter" escape hatch.
export const FIT_CHIP_TABS: FilterTab[] = [
  "inbox",
  "tailoring",
  "live",
  "interviewing",
  "backlog",
  "stale",
  "all",
];

// Tabs that render the filter bar at all — the union of the tabs that carry
// fit chips and the tabs that carry the facet "+ Filter" button. Only Closed
// is excluded, matching the pre-existing visibility of both controls. The
// profile and job-title families are offered on every tab in this set, and
// useFilteredJobs is handed empty selections elsewhere, so neither can sit
// hidden-and-active on a tab whose header doesn't render its row.
export const FILTER_BAR_TABS: FilterTab[] = [
  "inbox",
  "tailoring",
  "live",
  "interviewing",
  "backlog",
  "stale",
  "all",
];

/**
 * The badge families `tab` offers. Fit keeps its historical visibility; the
 * profile and job-title families are offered wherever the bar renders.
 */
export function filterChipTypesForTab(tab: FilterTab): JobFilterChipType[] {
  if (!FILTER_BAR_TABS.includes(tab)) return [];
  return JOB_FILTER_CHIP_TYPES.filter(
    (type) => type !== "fit" || FIT_CHIP_TABS.includes(tab),
  );
}

/**
 * Whether `type`'s badge row is on screen. This is the ONE expression that
 * decides it, and the PROFILE and TITLE families must narrow the list by
 * exactly the families it returns true for — the render gate and the
 * narrowing gate being the same call is what stops either from filtering a tab
 * that can neither show nor clear its badges.
 *
 * FIT is the exception, and deliberately so: its predicate stays global (an
 * `?fit=` link narrows wherever you land), so this governs its ROW only.
 * `FIT_CHIP_TABS` now covers every tab that renders the bar, which leaves
 * `closed` as the only place the two can disagree.
 *
 * Caveat this does not cover: on desktop the whole list panel — bar included —
 * can be collapsed, which hides every family's badges while they keep
 * narrowing. That predates this bar and applies equally to the facet chips.
 */
export function isFilterFamilyActive(
  availableTypes: JobFilterChipType[],
  enabledTypes: readonly JobFilterChipType[],
  type: JobFilterChipType,
): boolean {
  return availableTypes.includes(type) && enabledTypes.includes(type);
}

// The "Untailored" toggle lives on the Tailoring tab ONLY: it narrows the
// workspace to the not-yet-tailored rows (`processing`, which includes failed
// tailors awaiting retry), hiding the finished `ready` rows. Applied in
// useFilteredJobs only on this tab — the same scope as the control.
export const UNTAILORED_CHIP_TABS: FilterTab[] = ["tailoring"];

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
