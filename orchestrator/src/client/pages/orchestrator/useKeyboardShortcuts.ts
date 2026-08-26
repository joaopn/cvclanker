import * as api from "@client/api";
import {
  useMarkAsAppliedMutation,
  useSkipJobMutation,
} from "@client/hooks/queries/useJobMutations";
import { useHotkeys } from "@client/hooks/useHotkeys";
import { useActiveCv } from "@client/hooks/useActiveCv";
import { useSettings } from "@client/hooks/useSettings";
import { SHORTCUTS, isShortcutInScope } from "@client/lib/shortcut-map";
import type { JobAction, JobListItem } from "@shared/types.js";
import { useCallback, useRef } from "react";
import { toast } from "@client/lib/toast";
import { safeFilenamePart } from "@/lib/utils";
import type { FilterTab } from "./constants";
import { tabs } from "./constants";

type UseKeyboardShortcutsArgs = {
  isAnyModalOpen: boolean;
  isAnyModalOpenExcludingCommandBar: boolean;
  isAnyModalOpenExcludingHelp: boolean;
  activeTab: FilterTab;
  activeJobs: JobListItem[];
  selectedJobId: string | null;
  selectedJob: JobListItem | null;
  selectedJobIds: Set<string>;
  isDesktop: boolean;
  handleSelectJobId: (id: string | null) => void;
  requestScrollToJob: (id: string, opts?: { ensureSelected?: boolean }) => void;
  setActiveTab: (tab: FilterTab) => void;
  setIsCommandBarOpen: (open: boolean) => void;
  setIsHelpDialogOpen: (updater: (prev: boolean) => boolean) => void;
  clearSelection: () => void;
  toggleSelectJob: (id: string, options?: { range?: boolean }) => void;
  // Same exclusions as the hook's dispatcher: mark_closed needs an outcome,
  // fetch_live_status and retailor must go through their subset-filtering
  // dispatchers.
  runJobAction: (
    action: Exclude<
      JobAction,
      "mark_closed" | "fetch_live_status" | "retailor"
    >,
  ) => Promise<void>;
  loadJobs: () => Promise<void>;
  onUndo: () => void;
};

export function useKeyboardShortcuts(args: UseKeyboardShortcutsArgs): void {
  const {
    isAnyModalOpen,
    isAnyModalOpenExcludingCommandBar,
    isAnyModalOpenExcludingHelp,
    activeTab,
    activeJobs,
    selectedJobId,
    selectedJob,
    selectedJobIds,
    isDesktop: _isDesktop,
    handleSelectJobId,
    requestScrollToJob,
    setActiveTab,
    setIsCommandBarOpen,
    setIsHelpDialogOpen,
    clearSelection,
    toggleSelectJob,
    runJobAction,
    loadJobs,
    onUndo,
  } = args;

  const shortcutActionInFlight = useRef(false);
  const markAsAppliedMutation = useMarkAsAppliedMutation();
  const skipJobMutation = useSkipJobMutation();
  const { personName } = useActiveCv();
  const { cvSourceFormat } = useSettings();

  const navigateJobList = useCallback(
    (direction: 1 | -1) => {
      if (activeJobs.length === 0) return;
      const currentIndex = selectedJobId
        ? activeJobs.findIndex((j) => j.id === selectedJobId)
        : -1;
      const nextIndex = Math.max(
        0,
        Math.min(activeJobs.length - 1, currentIndex + direction),
      );
      const nextJob = activeJobs[nextIndex];
      if (nextJob && nextJob.id !== selectedJobId) {
        handleSelectJobId(nextJob.id);
        requestScrollToJob(nextJob.id);
      }
    },
    [activeJobs, selectedJobId, handleSelectJobId, requestScrollToJob],
  );

  const navigateTab = useCallback(
    (direction: 1 | -1) => {
      const currentIndex = tabs.findIndex((t) => t.id === activeTab);
      const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
      setActiveTab(tabs[nextIndex].id);
    },
    [activeTab, setActiveTab],
  );

  const selectNextAfterAction = useCallback(
    (movedJobId: string) => {
      const idx = activeJobs.findIndex((j) => j.id === movedJobId);
      const next = activeJobs[idx + 1] || activeJobs[idx - 1];
      handleSelectJobId(next?.id ?? null);
    },
    [activeJobs, handleSelectJobId],
  );

  useHotkeys(
    {
      // ── Navigation ──────────────────────────────────────────────────────
      [SHORTCUTS.nextJob.key]: (e) => {
        e.preventDefault();
        navigateJobList(1);
      },
      [SHORTCUTS.nextJobArrow.key]: (e) => {
        e.preventDefault();
        navigateJobList(1);
      },
      [SHORTCUTS.prevJob.key]: (e) => {
        e.preventDefault();
        navigateJobList(-1);
      },
      [SHORTCUTS.prevJobArrow.key]: (e) => {
        e.preventDefault();
        navigateJobList(-1);
      },

      // ── Tab switching ───────────────────────────────────────────────────
      [SHORTCUTS.tabInbox.key]: () => setActiveTab("inbox"),
      [SHORTCUTS.tabTailoring.key]: () => setActiveTab("tailoring"),
      [SHORTCUTS.tabLive.key]: () => setActiveTab("live"),
      [SHORTCUTS.tabBacklog.key]: () => setActiveTab("backlog"),
      [SHORTCUTS.tabStale.key]: () => setActiveTab("stale"),
      [SHORTCUTS.tabClosed.key]: () => setActiveTab("closed"),
      [SHORTCUTS.tabAll.key]: () => setActiveTab("all"),
      [SHORTCUTS.prevTabArrow.key]: (e) => {
        e.preventDefault();
        navigateTab(-1);
      },
      [SHORTCUTS.nextTabArrow.key]: (e) => {
        e.preventDefault();
        navigateTab(1);
      },

      // ── Undo ────────────────────────────────────────────────────────────
      [SHORTCUTS.undo.key]: (e) => {
        // The hotkey wrapper lets $mod+ shortcuts fire inside inputs; for undo
        // we must NOT clobber the browser's native text-undo, so bail when an
        // editable element is focused.
        const el = document.activeElement as HTMLElement | null;
        const tag = el?.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          el?.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        onUndo();
      },

      // ── Context actions ─────────────────────────────────────────────────
      [SHORTCUTS.skip.key]: () => {
        if (!isShortcutInScope(SHORTCUTS.skip, activeTab)) return;
        if (shortcutActionInFlight.current) return;

        if (selectedJobIds.size > 0) {
          void runJobAction("skip");
          return;
        }

        if (!selectedJob) return;
        shortcutActionInFlight.current = true;
        const jobId = selectedJob.id;
        skipJobMutation
          .mutateAsync(jobId)
          .then(async () => {
            toast.message("Job skipped");
            selectNextAfterAction(jobId);
            await loadJobs();
          })
          .catch((err: unknown) => {
            const msg =
              err instanceof Error ? err.message : "Failed to skip job";
            toast.error(msg);
          })
          .finally(() => {
            shortcutActionInFlight.current = false;
          });
      },

      [SHORTCUTS.markApplied.key]: () => {
        if (!selectedJob) return;
        if (selectedJob.status !== "ready") return;
        if (shortcutActionInFlight.current) return;
        shortcutActionInFlight.current = true;
        const jobId = selectedJob.id;
        markAsAppliedMutation
          .mutateAsync(jobId)
          .then(async () => {
            toast.success("Marked as applied", {
              description: `${selectedJob.title} at ${selectedJob.employer}`,
            });
            selectNextAfterAction(jobId);
            await loadJobs();
          })
          .catch((err: unknown) => {
            const msg =
              err instanceof Error ? err.message : "Failed to mark as applied";
            toast.error(msg);
          })
          .finally(() => {
            shortcutActionInFlight.current = false;
          });
      },

      [SHORTCUTS.moveToReady.key]: () => {
        if (!isShortcutInScope(SHORTCUTS.moveToReady, activeTab)) return;
        if (shortcutActionInFlight.current) return;

        if (selectedJobIds.size > 0) {
          void runJobAction("move_to_ready");
          return;
        }

        if (!selectedJob) return;

        shortcutActionInFlight.current = true;
        const jobId = selectedJob.id;

        api
          .processJob(jobId)
          .then(async () => {
            toast.success("Tailoring started", {
              description: "It'll appear in the Tailoring tab when ready.",
            });
            selectNextAfterAction(jobId);
            await loadJobs();
          })
          .catch((err: unknown) => {
            const msg =
              err instanceof Error ? err.message : "Failed to tailor job";
            toast.error(msg);
          })
          .finally(() => {
            shortcutActionInFlight.current = false;
          });
      },

      [SHORTCUTS.moveToBacklog.key]: () => {
        if (!isShortcutInScope(SHORTCUTS.moveToBacklog, activeTab)) return;
        if (shortcutActionInFlight.current) return;
        if (selectedJobIds.size > 0) {
          void runJobAction("move_to_backlog");
        }
      },

      [SHORTCUTS.moveToInbox.key]: () => {
        if (!isShortcutInScope(SHORTCUTS.moveToInbox, activeTab)) return;
        if (shortcutActionInFlight.current) return;
        if (selectedJobIds.size > 0) {
          void runJobAction("move_to_inbox");
        }
      },

      [SHORTCUTS.reopenJob.key]: () => {
        if (!isShortcutInScope(SHORTCUTS.reopenJob, activeTab)) return;
        if (shortcutActionInFlight.current) return;
        if (selectedJobIds.size > 0) {
          void runJobAction("reopen");
        }
      },

      [SHORTCUTS.viewPdf.key]: () => {
        if (!selectedJob) return;
        if (selectedJob.status !== "ready") return;
        const href = `/pdfs/resume_${selectedJob.id}.pdf?v=${encodeURIComponent(selectedJob.updatedAt)}`;
        window.open(href, "_blank", "noopener,noreferrer");
      },

      [SHORTCUTS.downloadPdf.key]: () => {
        if (!selectedJob) return;
        if (selectedJob.status !== "ready") return;
        // Must track the Download button in ReadyPanel: on a Word profile the
        // editable .docx is the artifact, and the PDF stays a view (`p`).
        const ext = cvSourceFormat === "docx" ? "docx" : "pdf";
        const href = `/pdfs/resume_${selectedJob.id}.${ext}?v=${encodeURIComponent(selectedJob.updatedAt)}`;
        const a = document.createElement("a");
        a.href = href;
        a.download = `${safeFilenamePart(personName || "Unknown")}_${safeFilenamePart(selectedJob.employer)}.${ext}`;
        a.click();
      },

      [SHORTCUTS.openListing.key]: () => {
        if (!selectedJob) return;
        const link = selectedJob.applicationLink || selectedJob.jobUrl;
        if (link) window.open(link, "_blank", "noopener,noreferrer");
      },

      [SHORTCUTS.toggleSelect.key]: () => {
        if (!selectedJobId) return;
        toggleSelectJob(selectedJobId);
      },

      [SHORTCUTS.clearSelection.key]: () => {
        if (selectedJobIds.size > 0) clearSelection();
      },
    },
    { enabled: !isAnyModalOpen },
  );

  useHotkeys(
    {
      // ── Search ──────────────────────────────────────────────────────────
      [SHORTCUTS.searchSlash.key]: (e) => {
        e.preventDefault();
        setIsCommandBarOpen(true);
      },
    },
    { enabled: !isAnyModalOpenExcludingCommandBar },
  );

  useHotkeys(
    {
      // ── Help ────────────────────────────────────────────────────────────
      [SHORTCUTS.help.key]: (e) => {
        e.preventDefault();
        setIsHelpDialogOpen((prev) => !prev);
      },
    },
    { enabled: !isAnyModalOpenExcludingHelp },
  );
}
