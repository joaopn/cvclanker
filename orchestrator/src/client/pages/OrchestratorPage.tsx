import * as api from "@client/api";
import { PipelineRunBanner } from "@client/components/PipelineRunBanner";
import { useActiveCvName } from "@client/hooks/useActiveCv";
import { useKeyboardAvailability } from "@client/hooks/useKeyboardAvailability";
import { useLlmCallQueue } from "@client/hooks/useLlmCallQueue";
import {
  LIST_PANEL_MAX_WIDTH,
  LIST_PANEL_MIN_WIDTH,
  useResizableListPanel,
} from "@client/hooks/useResizableListPanel";
import { useSettings } from "@client/hooks/useSettings";
import { useQuery } from "@tanstack/react-query";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { queryKeys } from "@/client/lib/queryKeys";
import type { VirtualListHandle } from "@/client/lib/virtual-list";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerClose, DrawerContent } from "@/components/ui/drawer";
import { KeyboardShortcutBar } from "../components/KeyboardShortcutBar";
import { KeyboardShortcutDialog } from "../components/KeyboardShortcutDialog";
import { BatchUrlImportSheet } from "./orchestrator/BatchUrlImportSheet";
import { ClosedFilterChips } from "./orchestrator/ClosedFilterChips";
import { CompanyJobsDialog } from "./orchestrator/CompanyJobsDialog";
import { CompanyPanelProvider } from "./orchestrator/CompanyPanelContext";
import {
  FACET_TABS,
  FILTER_BAR_TABS,
  type FilterTab,
  filterChipTypesForTab,
  isFilterFamilyActive,
  type JobSorter,
  orderedFilterSources,
  tabs,
  UNATTRIBUTED_PROFILE_ID,
} from "./orchestrator/constants";
import { DuplicateReviewModal } from "./orchestrator/DuplicateReviewModal";
import { FacetBar } from "./orchestrator/FacetBar";
import { FloatingJobActionsBar } from "./orchestrator/FloatingJobActionsBar";
import type { ActiveFacet } from "./orchestrator/facets/registry";
import { JobCommandBar } from "./orchestrator/JobCommandBar";
import { JobDetailPanel } from "./orchestrator/JobDetailPanel";
import { JobFilterBar } from "./orchestrator/JobFilterBar";
import { JobListPanel } from "./orchestrator/JobListPanel";
import {
  JobListSplitter,
  JobListToggleBar,
} from "./orchestrator/JobListSplitter";
import { LlmCallQueueSheet } from "./orchestrator/LlmCallQueueSheet";
import { OrchestratorFilters } from "./orchestrator/OrchestratorFilters";
import { OrchestratorHeader } from "./orchestrator/OrchestratorHeader";
import { ProfileSelect } from "./orchestrator/ProfileSelect";
import { RunPipelineMenu } from "./orchestrator/RunPipelineMenu";
import { StaleControlBar } from "./orchestrator/StaleControlBar";
import { useDuplicateGroups } from "./orchestrator/useDuplicateGroups";
import { useFacetFilters } from "./orchestrator/useFacetFilters";
import { useFilteredJobs } from "./orchestrator/useFilteredJobs";
import { useJobFilterChips } from "./orchestrator/useJobFilterChips";
import { useJobSelectionActions } from "./orchestrator/useJobSelectionActions";
import { useKeyboardShortcuts } from "./orchestrator/useKeyboardShortcuts";
import { useOrchestratorData } from "./orchestrator/useOrchestratorData";
import { useOrchestratorFilters } from "./orchestrator/useOrchestratorFilters";
import { usePipelineControls } from "./orchestrator/usePipelineControls";
import { useScrollToJobItem } from "./orchestrator/useScrollToJobItem";
import { useSelectedProfile } from "./orchestrator/useSelectedProfile";
import {
  UndoProvider,
  useUndoController,
} from "./orchestrator/useUndoController";
import {
  collectProfileSearchTitles,
  getEnabledSources,
  getJobCountsFromStats,
  getSourcesWithJobs,
} from "./orchestrator/utils";

// Stable empty reference for tabs that don't surface the facet bar, so the
// useFilteredJobs memo isn't busted by a fresh [] each render.
const EMPTY_ACTIVE_FACETS: ActiveFacet[] = [];
// Same, for the profile / job-title badge selections on tabs without the bar.
const EMPTY_CHIP_FILTER: string[] = [];

// Keep only the picks still offered as a badge, returning the original array
// when nothing was dropped so the useFilteredJobs memo isn't busted.
function keepOfferedChips(selected: string[], offered: string[]): string[] {
  if (selected.length === 0) return EMPTY_CHIP_FILTER;
  const available = new Set(offered);
  const kept = selected.filter((value) => available.has(value));
  if (kept.length === selected.length) return selected;
  return kept.length === 0 ? EMPTY_CHIP_FILTER : kept;
}

// Whether a job of `status` is part of `tab`'s visible list. Mirrors
// useFilteredJobs — needed here so a selected row isn't nulled out / dropped on
// tab switch. The Tailoring workspace is always `processing` + `ready`; the
// Untailored toggle only narrows within it (it doesn't change what belongs).
function jobBelongsToTab(tab: FilterTab, status: string): boolean {
  const tabDef = tabs.find((t) => t.id === tab);
  if (!tabDef || tabDef.statuses.length === 0) return true;
  if (tab === "tailoring") {
    return status === "processing" || status === "ready";
  }
  return (tabDef.statuses as string[]).includes(status);
}

export const OrchestratorPage: React.FC = () => {
  const { tab, jobId } = useParams<{ tab: string; jobId?: string }>();
  const navigate = useNavigate();
  const {
    searchParams,
    sourceFilter,
    setSourceFilter,
    sponsorFilter,
    setSponsorFilter,
    salaryFilter,
    setSalaryFilter,
    dateFilter,
    setDateFilter,
    sort,
    setSort,
    sorter,
    setSorter,
    maxAgeDays,
    setMaxAgeDays,
    closedSubFilter,
    setClosedSubFilter,
    staleThresholdDays,
    setStaleThresholdDays,
    fitFilter,
    setFitFilter,
    untailoredOnly,
    setUntailoredOnly,
    resetFilters,
  } = useOrchestratorFilters();
  const facetFilters = useFacetFilters();
  // Switching the Fit family off has to clear the URL-owned fit selection, or
  // it would keep narrowing the list with its chips hidden.
  const clearFitFilter = useCallback(() => setFitFilter([]), [setFitFilter]);
  const filterChips = useJobFilterChips({ clearFitFilter });
  // Reset clears the URL-owned filters AND the ephemeral ones, so the button
  // doesn't leave the list narrowed by badges it never mentioned.
  const clearChipSelections = filterChips.clearSelections;
  const clearFacets = facetFilters.clearFacets;
  const handleResetFilters = useCallback(() => {
    resetFilters();
    clearChipSelections();
    clearFacets();
  }, [resetFilters, clearChipSelections, clearFacets]);

  const activeTab = useMemo(() => {
    const validTabs: FilterTab[] = [
      "inbox",
      "tailoring",
      "live",
      "interviewing",
      "backlog",
      "stale",
      "closed",
      "all",
    ];
    if (tab && validTabs.includes(tab as FilterTab)) {
      return tab as FilterTab;
    }
    return "inbox";
  }, [tab]);

  // Helper to change URL while preserving search params
  const navigateWithContext = useCallback(
    (newTab: string, newJobId?: string | null, isReplace = false) => {
      const search = searchParams.toString();
      const suffix = search ? `?${search}` : "";
      const path = newJobId
        ? `/jobs/${newTab}/${newJobId}${suffix}`
        : `/jobs/${newTab}${suffix}`;
      navigate(path, { replace: isReplace });
    },
    [navigate, searchParams],
  );

  const selectedJobId = jobId || null;
  const jobListHandleRef = useRef<VirtualListHandle | null>(null);

  // Effect to sync URL if it was invalid
  useEffect(() => {
    // Legacy URL redirects for the pre-5g tab names so existing bookmarks
    // don't 404. Routes the old name to the closest 5g tab.
    if (tab === "discovered") {
      navigateWithContext("inbox", null, true);
      return;
    }
    if (tab === "applied") {
      navigateWithContext("live", null, true);
      return;
    }
    if (tab === "in_progress") {
      navigateWithContext("interviewing", null, true);
      return;
    }
    // Selected tab removed; Ready renamed to Tailoring. Route old bookmarks
    // to the closest current tab.
    if (tab === "selected") {
      navigateWithContext("inbox", null, true);
      return;
    }
    if (tab === "ready") {
      navigateWithContext("tailoring", null, true);
      return;
    }
    const validTabs: FilterTab[] = [
      "inbox",
      "tailoring",
      "live",
      "interviewing",
      "backlog",
      "stale",
      "closed",
      "all",
    ];
    if (tab && !validTabs.includes(tab as FilterTab)) {
      navigateWithContext("inbox", null, true);
    }
  }, [tab, navigate, navigateWithContext]);

  const [navOpen, setNavOpen] = useState(false);
  const [isCommandBarOpen, setIsCommandBarOpen] = useState(false);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [isHelpDialogOpen, setIsHelpDialogOpen] = useState(false);
  const [isDetailDrawerOpen, setIsDetailDrawerOpen] = useState(false);
  const [isBatchUrlImportOpen, setIsBatchUrlImportOpen] = useState(false);
  const [isLlmQueueOpen, setIsLlmQueueOpen] = useState(false);
  const llmQueue = useLlmCallQueue(true);
  const hasKeyboard = useKeyboardAvailability();

  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(min-width: 1024px)").matches
      : false,
  );

  const {
    width: listPanelWidth,
    isVisible: isListPanelVisible,
    isDragging: isListPanelDragging,
    toggleVisible: toggleListPanelVisible,
    startDrag: startListPanelDrag,
  } = useResizableListPanel();

  const handleSelectJobId = useCallback(
    (id: string | null) => {
      navigateWithContext(activeTab, id);
    },
    [navigateWithContext, activeTab],
  );

  const {
    settings,
    inboxStaleThresholdDays,
    maxBulkActionJobs,
    hasScorerPrefilter,
  } = useSettings();
  const effectiveStaleThresholdDays =
    staleThresholdDays ?? inboxStaleThresholdDays;
  // Facets narrow (and their bar renders) only on FACET_TABS; a Tier-2 facet
  // active there makes the inbox fetch the full job payload.
  const facetsEnabledForTab = FACET_TABS.includes(activeTab);
  // The filter bar (family tickboxes + badge rows) renders on a wider set than
  // the facets — everything except Closed.
  const filterBarEnabledForTab = FILTER_BAR_TABS.includes(activeTab);
  const needsFullView = facetsEnabledForTab && facetFilters.requiresFullView;
  // Statuses the active tab shows — the data hook fetches ONLY these rows,
  // so terminal shelves (Closed, Stale, …) load lazily when first opened
  // instead of riding along on every Inbox refresh. All fetches unscoped.
  const scopeStatuses = useMemo(() => {
    const tabDef = tabs.find((t) => t.id === activeTab);
    return tabDef && tabDef.statuses.length > 0 ? tabDef.statuses : undefined;
  }, [activeTab]);
  const {
    jobs,
    selectedJob,
    stats,
    isLoading,
    isPipelineRunning,
    setIsPipelineRunning,
    pipelineTerminalEvent,
    setIsRefreshPaused,
    loadJobs,
  } = useOrchestratorData(selectedJobId, needsFullView, scopeStatuses);
  const enabledSources = useMemo(
    () => getEnabledSources(settings ?? null),
    [settings],
  );

  // The command bar searches "across all states", while the tab list is now
  // scoped — so it lazily fetches the unscoped list itself, only once the
  // dialog opens, falling back to the scoped rows while that loads.
  const { data: commandBarData } = useQuery({
    queryKey: queryKeys.jobs.list({ view: "list" }),
    queryFn: () => api.getJobs({ view: "list" }),
    enabled: isCommandBarOpen,
    staleTime: 30_000,
  });
  const commandBarJobs = commandBarData?.jobs ?? jobs;

  const undoController = useUndoController(loadJobs);

  const [companyPanelEmployer, setCompanyPanelEmployer] = useState<
    string | null
  >(null);
  const companyPanel = useMemo(
    () => ({
      openCompanyJobs: (employer: string) => setCompanyPanelEmployer(employer),
    }),
    [],
  );

  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState(false);
  const [isDuplicateBannerDismissed, setIsDuplicateBannerDismissed] =
    useState(false);
  const {
    groups: duplicateGroups,
    count: duplicateCount,
    refetch: refetchDuplicates,
  } = useDuplicateGroups();

  // Keep the banner count in sync with the job list (new finds, resolutions,
  // status moves all change `jobs`).
  useEffect(() => {
    void refetchDuplicates();
  }, [jobs, refetchDuplicates]);

  const handleDuplicatesResolved = useCallback(() => {
    void loadJobs();
    void refetchDuplicates();
  }, [loadJobs, refetchDuplicates]);

  const {
    isCancelling,
    runPipelineNow,
    handleCancelPipeline,
    handleRerunSource,
    handleRerunSources,
  } = usePipelineControls({
    isPipelineRunning,
    setIsPipelineRunning,
    pipelineTerminalEvent,
  });

  const { profiles, selectedProfileIds, toggleProfile } = useSelectedProfile();

  const profileSearchTitles = useMemo(
    () => collectProfileSearchTitles(profiles),
    [profiles],
  );

  const availableFilterChipTypes = useMemo(
    () => filterChipTypesForTab(activeTab),
    [activeTab],
  );

  const activeFacetsForTab = facetsEnabledForTab
    ? facetFilters.activeFacets
    : EMPTY_ACTIVE_FACETS;
  // Narrow by exactly the families whose row is on screen — same call the bar
  // renders from — and drop any pick whose badge is no longer offered (a
  // profile deleted, a search term edited away). A selection with no chip left
  // to click would otherwise narrow the list with nothing to clear it.
  const knownProfileIds = useMemo(
    () => profiles.map((profile) => profile.id),
    [profiles],
  );
  const profileFilterForTab = useMemo(
    () =>
      keepOfferedChips(
        isFilterFamilyActive(
          availableFilterChipTypes,
          filterChips.enabledTypes,
          "profile",
        )
          ? filterChips.profileFilter
          : EMPTY_CHIP_FILTER,
        // Exactly what the row renders: with no profiles the bar shows a hint
        // instead of chips, so nothing is offered and a stale pick stops
        // narrowing rather than becoming unclickable.
        knownProfileIds.length === 0
          ? EMPTY_CHIP_FILTER
          : [...knownProfileIds, UNATTRIBUTED_PROFILE_ID],
      ),
    [
      availableFilterChipTypes,
      filterChips.enabledTypes,
      filterChips.profileFilter,
      knownProfileIds,
    ],
  );
  const titleFilterForTab = useMemo(
    () =>
      keepOfferedChips(
        isFilterFamilyActive(
          availableFilterChipTypes,
          filterChips.enabledTypes,
          "title",
        )
          ? filterChips.titleFilter
          : EMPTY_CHIP_FILTER,
        profileSearchTitles,
      ),
    [
      availableFilterChipTypes,
      filterChips.enabledTypes,
      filterChips.titleFilter,
      profileSearchTitles,
    ],
  );
  // Only a facet with a non-blank value actually narrows the list — that is
  // what drives the "no jobs match your filters" empty state (an empty chip
  // filters nothing). The profile / job-title badges narrow as soon as one is
  // picked, so they count the moment their arrays are non-empty.
  const filtersActive =
    (facetsEnabledForTab &&
      facetFilters.activeFacets.some(
        (facet) => facet.value.trim().length > 0,
      )) ||
    profileFilterForTab.length > 0 ||
    titleFilterForTab.length > 0;

  // The sorter icon lives on the filter bar, so it acts only where the bar
  // renders — same co-gating as the profile / job-title families.
  const sorterForTab: JobSorter = filterBarEnabledForTab ? sorter : "none";

  const activeJobs = useFilteredJobs(
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
    activeFacetsForTab,
    profileFilterForTab,
    titleFilterForTab,
    knownProfileIds,
    sorterForTab,
  );
  const setActiveTab = useCallback(
    (newTab: FilterTab) => {
      // Keep selected job if it belongs to the target tab, otherwise clear it.
      // The auto-select effect will pick the first job on desktop when cleared.
      const selectedItem = selectedJobId
        ? jobs.find((j) => j.id === selectedJobId)
        : null;
      const jobFitsTab =
        !!selectedItem && jobBelongsToTab(newTab, selectedItem.status);
      navigateWithContext(newTab, jobFitsTab ? selectedJobId : null);
    },
    [navigateWithContext, selectedJobId, jobs],
  );

  // Synchronously null-out selectedJob when it doesn't belong to the current
  // tab. The data hook resolves selectedJob from the full (unfiltered) job list
  // via useEffect, so it lags by one render frame after a tab switch — without
  // this guard the detail panel would briefly show the old job with the new
  // tab's action buttons.
  const visibleSelectedJob = useMemo(() => {
    if (!selectedJob) return null;
    return jobBelongsToTab(activeTab, selectedJob.status) ? selectedJob : null;
  }, [selectedJob, activeTab]);

  const counts = useMemo(() => getJobCountsFromStats(stats), [stats]);
  const displayedCounts = useMemo(() => counts, [counts]);
  // Sources present on the ACTIVE tab (the list payload is scoped), plus the
  // active selection so its chip stays rendered — and clearable — on a tab
  // with no such rows. "No rows anywhere" is no longer knowable client-side,
  // so nothing auto-resets the filter; the filtered empty state and Reset
  // cover a dead selection.
  const sourcesWithJobs = useMemo(() => {
    const sources = getSourcesWithJobs(jobs);
    if (sourceFilter === "all" || sources.includes(sourceFilter)) {
      return sources;
    }
    return orderedFilterSources.filter(
      (source) => source === sourceFilter || sources.includes(source),
    );
  }, [jobs, sourceFilter]);
  const {
    selectedJobIds,
    canSkipSelected,
    canMoveSelected,
    canRescoreSelected,
    canClearScoreSelected,
    canRescrapeSelected,
    canMoveToBacklogSelected,
    canMoveToStaleSelected,
    canMoveToInboxSelected,
    canMarkClosedSelected,
    canReopenSelected,
    canDeleteSelected,
    canFetchLiveStatusSelected,
    canRetailorSelected,
    retailorableCount,
    jobActionInFlight,
    toggleSelectJob,
    toggleSelectAll,
    clearSelection,
    runJobAction,
    runScreenedRescoreAction,
    runFetchLiveStatusAction,
    runRetailorAction,
    runMarkClosedAction,
  } = useJobSelectionActions({
    activeJobs,
    activeTab,
    loadJobs,
    maxBulkActionJobs,
    pushUndo: undoController.pushUndo,
    undo: undoController.undo,
  });

  // Only fetched when the Generate confirm can actually be opened — the dialog
  // names the CV the re-tailor will run against, and "active" here means the
  // most recently updated document, not a user-chosen one.
  const activeCvName = useActiveCvName(
    activeTab === "tailoring" && canRetailorSelected,
  );

  const handleSelectJob = (id: string) => {
    handleSelectJobId(id);
    if (!isDesktop) {
      setIsDetailDrawerOpen(true);
    }
  };

  const { requestScrollToJob } = useScrollToJobItem({
    activeJobs,
    selectedJobId,
    isDesktop,
    onEnsureJobSelected: (id) => navigateWithContext(activeTab, id, true),
    listHandleRef: jobListHandleRef,
  });

  const isAnyModalOpen =
    isCommandBarOpen ||
    isFiltersOpen ||
    isHelpDialogOpen ||
    isDetailDrawerOpen ||
    isBatchUrlImportOpen ||
    isLlmQueueOpen ||
    isDuplicateModalOpen ||
    navOpen;

  const isAnyModalOpenExcludingCommandBar =
    isFiltersOpen ||
    isHelpDialogOpen ||
    isDetailDrawerOpen ||
    isBatchUrlImportOpen ||
    isLlmQueueOpen ||
    isDuplicateModalOpen ||
    navOpen;

  const isAnyModalOpenExcludingHelp =
    isCommandBarOpen ||
    isFiltersOpen ||
    isDetailDrawerOpen ||
    isBatchUrlImportOpen ||
    isLlmQueueOpen ||
    isDuplicateModalOpen ||
    navOpen;

  useKeyboardShortcuts({
    isAnyModalOpen,
    isAnyModalOpenExcludingCommandBar,
    isAnyModalOpenExcludingHelp,
    activeTab,
    activeJobs,
    selectedJobId,
    selectedJob: visibleSelectedJob,
    selectedJobIds,
    isDesktop,
    handleSelectJobId,
    requestScrollToJob,
    setActiveTab,
    setIsCommandBarOpen,
    setIsHelpDialogOpen,
    clearSelection,
    toggleSelectJob,
    runJobAction,
    loadJobs,
    onUndo: undoController.undo,
  });

  const handleCommandSelectJob = useCallback(
    (targetTab: FilterTab, id: string) => {
      requestScrollToJob(id, { ensureSelected: true });
      const nextParams = new URLSearchParams(searchParams);
      for (const key of [
        "source",
        "sponsor",
        "salaryMode",
        "salaryMin",
        "salaryMax",
        "minSalary",
        "date",
        "appliedRange",
        "appliedStart",
        "appliedEnd",
        "maxAge",
        "closedFilter",
      ]) {
        nextParams.delete(key);
      }
      const query = nextParams.toString();
      navigate(`/jobs/${targetTab}/${id}${query ? `?${query}` : ""}`);
      if (!isDesktop) {
        setIsDetailDrawerOpen(true);
      }
    },
    [isDesktop, navigate, requestScrollToJob, searchParams],
  );

  useEffect(() => {
    if (activeJobs.length === 0) {
      if (selectedJobId) handleSelectJobId(null);
      return;
    }
    if (!selectedJobId) {
      // Auto-select first job ONLY on desktop when nothing is currently selected.
      if (isDesktop) {
        navigateWithContext(activeTab, activeJobs[0].id, true);
      }
    }
  }, [
    activeJobs,
    selectedJobId,
    isDesktop,
    activeTab,
    navigateWithContext,
    handleSelectJobId,
  ]);

  useEffect(() => {
    if (!selectedJobId) {
      setIsDetailDrawerOpen(false);
    } else if (!isDesktop) {
      setIsDetailDrawerOpen(true);
    }
  }, [selectedJobId, isDesktop]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(min-width: 1024px)");
    const handleChange = () => setIsDesktop(media.matches);
    handleChange();
    if (media.addEventListener) {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }
    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (isDesktop && isDetailDrawerOpen) {
      setIsDetailDrawerOpen(false);
    }
  }, [isDesktop, isDetailDrawerOpen]);

  useEffect(() => {
    if (!hasKeyboard) return;
    const hasSeen = localStorage.getItem("has-seen-keyboard-shortcuts");
    if (!hasSeen) {
      setIsHelpDialogOpen(true);
    }
  }, [hasKeyboard]);

  const onDrawerOpenChange = (open: boolean) => {
    setIsDetailDrawerOpen(open);
    if (!open && !isDesktop) {
      // Clear job ID from URL when closing drawer on mobile
      handleSelectJobId(null);
    }
  };

  const primaryEmptyStateAction = useMemo(() => {
    if (activeTab === "tailoring" && counts.discovered > 0) {
      return {
        label: "Review Inbox",
        onClick: () => setActiveTab("inbox"),
      };
    }

    if (activeTab === "inbox" || activeTab === "all") {
      return {
        label: "Run pipeline",
        onClick: () => runPipelineNow(selectedProfileIds),
      };
    }

    return undefined;
  }, [
    activeTab,
    counts.discovered,
    runPipelineNow,
    selectedProfileIds,
    setActiveTab,
  ]);

  const secondaryEmptyStateAction = useMemo(() => {
    if (activeTab === "tailoring") {
      return {
        label: "Run pipeline",
        onClick: () => runPipelineNow(selectedProfileIds),
      };
    }

    return undefined;
  }, [activeTab, runPipelineNow, selectedProfileIds]);

  const emptyStateMessage = useMemo(() => {
    if (dateFilter.dimensions.length === 0) {
      return undefined;
    }

    return "No jobs match the selected date filters.";
  }, [dateFilter.dimensions.length]);

  return (
    <UndoProvider value={undoController}>
      <CompanyPanelProvider value={companyPanel}>
        {/* Desktop: viewport-height app shell so the list/detail region fills
          exactly the space left under the header/banner/filters — no magic
          `100vh - Nrem` math, no document scroll. Below lg the `lg:` classes
          drop off and the page scrolls normally. */}
        <div className="lg:flex lg:h-screen lg:flex-col lg:overflow-hidden">
          <OrchestratorHeader
            navOpen={navOpen}
            onNavOpenChange={setNavOpen}
            isPipelineRunning={isPipelineRunning}
            isCancelling={isCancelling}
            pipelineSources={enabledSources}
            profileSelect={
              <ProfileSelect
                profiles={profiles}
                selectedProfileIds={selectedProfileIds}
                onToggle={toggleProfile}
              />
            }
            runControl={
              <RunPipelineMenu
                selectedProfileIds={selectedProfileIds}
                onRun={(config) => {
                  void runPipelineNow(selectedProfileIds, config);
                }}
              />
            }
            onOpenBatchUrlImport={() => setIsBatchUrlImportOpen(true)}
            onOpenLlmQueue={() => setIsLlmQueueOpen(true)}
            llmActiveCount={llmQueue.active.length}
            onCancelPipeline={handleCancelPipeline}
            canUndo={undoController.canUndo}
            undoLabel={undoController.pendingLabel}
            onUndo={undoController.undo}
          />

          <PipelineRunBanner
            isRunning={isPipelineRunning}
            onRerunSource={handleRerunSource}
            onRerunSources={handleRerunSources}
          />

          <main
            className={`space-y-6 px-4 py-6 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:space-y-0 lg:overflow-hidden lg:pb-6 ${
              selectedJobIds.size > 0 ? "pb-36" : "pb-12"
            }`}
          >
            {/* Main content: tabs/filters -> list/detail */}
            <section className="space-y-4 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
              <JobCommandBar
                jobs={commandBarJobs}
                onSelectJob={handleCommandSelectJob}
                open={isCommandBarOpen}
                onOpenChange={setIsCommandBarOpen}
                enabled={!isAnyModalOpenExcludingCommandBar}
              />
              <OrchestratorFilters
                activeTab={activeTab}
                onTabChange={setActiveTab}
                counts={displayedCounts}
                onOpenCommandBar={() => setIsCommandBarOpen(true)}
                isFiltersOpen={isFiltersOpen}
                onFiltersOpenChange={setIsFiltersOpen}
                sourceFilter={sourceFilter}
                onSourceFilterChange={setSourceFilter}
                sponsorFilter={sponsorFilter}
                onSponsorFilterChange={setSponsorFilter}
                salaryFilter={salaryFilter}
                onSalaryFilterChange={setSalaryFilter}
                dateFilter={dateFilter}
                onDateFilterChange={setDateFilter}
                maxAgeDays={maxAgeDays}
                onMaxAgeDaysChange={setMaxAgeDays}
                sourcesWithJobs={sourcesWithJobs}
                sort={sort}
                onSortChange={setSort}
                sorter={sorterForTab}
                onResetFilters={handleResetFilters}
                filteredCount={activeJobs.length}
              />

              {duplicateCount > 0 && !isDuplicateBannerDismissed && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-status-warn/30 bg-status-warn/10 px-4 py-2 text-sm">
                  <span className="text-status-warn-text">
                    {duplicateCount} duplicate{" "}
                    {duplicateCount === 1 ? "group" : "groups"} (one posting id,
                    listed more than once)
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIsDuplicateModalOpen(true)}
                    >
                      Review duplicates
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setIsDuplicateBannerDismissed(true)}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}

              {/* List/Detail grid - directly under tabs, no extra section */}
              <div
                className={
                  isDesktop ? "grid min-h-0 flex-1 gap-0" : "grid gap-4"
                }
                style={
                  isDesktop
                    ? {
                        gridTemplateColumns: isListPanelVisible
                          ? `${listPanelWidth}px 12px 24px minmax(0, 1fr)`
                          : "24px minmax(0, 1fr)",
                        gridTemplateRows: "minmax(0, 1fr)",
                      }
                    : undefined
                }
              >
                {/* Primary region: Job list with highest visual weight */}
                {(!isDesktop || isListPanelVisible) && (
                  <JobListPanel
                    ref={jobListHandleRef}
                    isLoading={isLoading}
                    jobs={jobs}
                    activeJobs={activeJobs}
                    selectedJobId={selectedJobId}
                    selectedJobIds={selectedJobIds}
                    activeTab={activeTab}
                    onSelectJob={handleSelectJob}
                    onToggleSelectJob={toggleSelectJob}
                    onToggleSelectAll={toggleSelectAll}
                    fitFilter={fitFilter}
                    onFitFilterChange={setFitFilter}
                    untailoredOnly={untailoredOnly}
                    onUntailoredOnlyChange={setUntailoredOnly}
                    filterBar={
                      filterBarEnabledForTab ? (
                        <JobFilterBar
                          availableTypes={availableFilterChipTypes}
                          enabledTypes={filterChips.enabledTypes}
                          onToggleType={filterChips.toggleType}
                          fitFilter={fitFilter}
                          onFitFilterChange={setFitFilter}
                          profiles={profiles}
                          profileFilter={filterChips.profileFilter}
                          onToggleProfile={filterChips.toggleProfileFilter}
                          titles={profileSearchTitles}
                          titleFilter={filterChips.titleFilter}
                          onToggleTitle={filterChips.toggleTitleFilter}
                          sorter={sorter}
                          onSorterChange={setSorter}
                          facetBar={
                            facetsEnabledForTab ? (
                              <FacetBar
                                activeFacets={facetFilters.activeFacets}
                                onAddFacet={facetFilters.addFacet}
                                onRemoveFacet={facetFilters.removeFacet}
                                onSetFacetValue={facetFilters.setFacetValue}
                                onClearFacets={facetFilters.clearFacets}
                              />
                            ) : undefined
                          }
                        />
                      ) : undefined
                    }
                    filtersActive={filtersActive}
                    primaryEmptyStateAction={primaryEmptyStateAction}
                    secondaryEmptyStateAction={secondaryEmptyStateAction}
                    emptyStateMessage={emptyStateMessage}
                    staleThresholdDays={inboxStaleThresholdDays}
                    closedFilterChips={
                      activeTab === "closed" ? (
                        <ClosedFilterChips
                          value={closedSubFilter}
                          onChange={setClosedSubFilter}
                        />
                      ) : undefined
                    }
                    staleControlBar={
                      activeTab === "stale" ? (
                        <StaleControlBar
                          thresholdDays={effectiveStaleThresholdDays}
                          onThresholdChange={(value) =>
                            setStaleThresholdDays(value)
                          }
                          onSwept={loadJobs}
                        />
                      ) : undefined
                    }
                  />
                )}

                {isDesktop && isListPanelVisible && (
                  <JobListSplitter
                    onDrag={startListPanelDrag}
                    isDragging={isListPanelDragging}
                    width={listPanelWidth}
                    minWidth={LIST_PANEL_MIN_WIDTH}
                    maxWidth={LIST_PANEL_MAX_WIDTH}
                  />
                )}

                {isDesktop && (
                  <JobListToggleBar
                    isVisible={isListPanelVisible}
                    onClick={toggleListPanelVisible}
                  />
                )}

                {/* Inspector panel: visually subordinate to list */}
                {isDesktop && (
                  <div className="min-w-0 rounded-lg border border-border/40 bg-muted/5 p-4 lg:h-full lg:overflow-y-auto">
                    <JobDetailPanel
                      activeTab={activeTab}
                      activeJobs={activeJobs}
                      selectedJob={visibleSelectedJob}
                      onSelectJobId={handleSelectJobId}
                      onJobUpdated={loadJobs}
                      onPauseRefreshChange={setIsRefreshPaused}
                    />
                  </div>
                )}
              </div>
            </section>
          </main>
        </div>

        <FloatingJobActionsBar
          activeTab={activeTab}
          selectedCount={selectedJobIds.size}
          canMoveSelected={canMoveSelected}
          canSkipSelected={canSkipSelected}
          canRescoreSelected={canRescoreSelected}
          canClearScoreSelected={canClearScoreSelected}
          canRescrapeSelected={canRescrapeSelected}
          canMoveToBacklogSelected={canMoveToBacklogSelected}
          canMoveToStaleSelected={canMoveToStaleSelected}
          canMoveToInboxSelected={canMoveToInboxSelected}
          canMarkClosedSelected={canMarkClosedSelected}
          canReopenSelected={canReopenSelected}
          canDeleteSelected={canDeleteSelected}
          canFetchLiveStatusSelected={canFetchLiveStatusSelected}
          canRetailorSelected={canRetailorSelected}
          retailorableCount={retailorableCount}
          activeCvName={activeCvName}
          hasScorerPrefilter={hasScorerPrefilter}
          jobActionInFlight={jobActionInFlight !== null}
          onMoveToReady={() => void runJobAction("move_to_ready")}
          onSkipSelected={() => void runJobAction("skip")}
          onRescoreSelected={() => void runJobAction("rescore")}
          onScreenRescoreSelected={() => void runScreenedRescoreAction()}
          onClearScoreSelected={() => void runJobAction("clear_score")}
          onRescrapeSelected={() => void runJobAction("rescrape")}
          onMoveToBacklog={() => void runJobAction("move_to_backlog")}
          onMoveToStale={() => void runJobAction("move_to_stale")}
          onMoveToInbox={() => void runJobAction("move_to_inbox")}
          onMarkClosed={(outcome) => void runMarkClosedAction(outcome)}
          onReopen={() => void runJobAction("reopen")}
          onDelete={() => void runJobAction("delete")}
          onFetchLiveStatus={() => void runFetchLiveStatusAction()}
          onRetailor={() => void runRetailorAction()}
          onClear={clearSelection}
        />

        <DuplicateReviewModal
          open={isDuplicateModalOpen}
          onOpenChange={setIsDuplicateModalOpen}
          groups={duplicateGroups}
          onResolved={handleDuplicatesResolved}
          pushUndo={undoController.pushUndo}
          maxBulkActionJobs={maxBulkActionJobs}
        />

        <BatchUrlImportSheet
          open={isBatchUrlImportOpen}
          onOpenChange={setIsBatchUrlImportOpen}
          onCompleted={loadJobs}
        />

        <LlmCallQueueSheet
          open={isLlmQueueOpen}
          onOpenChange={setIsLlmQueueOpen}
          active={llmQueue.active}
          recent={llmQueue.recent}
          connected={llmQueue.connected}
        />

        {!isDesktop && (
          <Drawer open={isDetailDrawerOpen} onOpenChange={onDrawerOpenChange}>
            <DrawerContent className="max-h-[90vh]">
              <div className="flex items-center justify-between px-4 pt-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Job details
                </div>
                <DrawerClose asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                  >
                    Close
                  </Button>
                </DrawerClose>
              </div>
              <div className="max-h-[calc(90vh-3.5rem)] overflow-y-auto px-4 pb-6 pt-3">
                <JobDetailPanel
                  activeTab={activeTab}
                  activeJobs={activeJobs}
                  selectedJob={visibleSelectedJob}
                  onSelectJobId={handleSelectJobId}
                  onJobUpdated={loadJobs}
                  onPauseRefreshChange={setIsRefreshPaused}
                />
              </div>
            </DrawerContent>
          </Drawer>
        )}

        <KeyboardShortcutBar activeTab={activeTab} />
        <KeyboardShortcutDialog
          open={isHelpDialogOpen}
          onOpenChange={(open) => {
            setIsHelpDialogOpen(open);
            if (!open) {
              localStorage.setItem("has-seen-keyboard-shortcuts", "true");
            }
          }}
          activeTab={activeTab}
        />

        <CompanyJobsDialog
          employer={companyPanelEmployer}
          onClose={() => setCompanyPanelEmployer(null)}
          onSelectJob={handleCommandSelectJob}
        />
      </CompanyPanelProvider>
    </UndoProvider>
  );
};
