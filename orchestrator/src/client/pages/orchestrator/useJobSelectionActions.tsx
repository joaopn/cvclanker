import * as api from "@client/api";
import type {
  JobAction,
  JobActionRequest,
  JobActionResponse,
  JobListItem,
  JobOutcome,
} from "@shared/types.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@client/lib/toast";
import { type JobStateSnapshot, restoreJobStates, snapshotJob } from "@client/lib/undo";
import type { FilterTab } from "./constants";
import { JobActionProgressToast } from "./JobActionProgressToast";
import {
  canClearScore,
  canMarkClosed,
  canMoveToBacklog,
  canMoveToInbox,
  canMoveToReady,
  canMoveToStale,
  canReopen,
  canRescore,
  canRescrape,
  canSkip,
  getFailedJobIds,
} from "./jobActions";
import { clampNumber } from "./utils";

const jobActionLabel: Record<JobAction, string> = {
  move_to_ready: "Tailoring selected jobs...",
  skip: "Skipping selected jobs...",
  rescore: "Calculating match scores...",
  clear_score: "Clearing match scores...",
  rescrape: "Re-fetching from URL...",
  move_to_backlog: "Moving to Backlog...",
  move_to_stale: "Moving to Stale...",
  move_to_inbox: "Moving to Inbox...",
  mark_closed: "Closing applications...",
  mark_duplicated: "Marking duplicates...",
  reopen: "Reopening...",
};

const jobActionSuccessLabel: Record<JobAction, string> = {
  move_to_ready: "jobs sent to Tailoring",
  skip: "jobs skipped",
  rescore: "matches recalculated",
  clear_score: "matches cleared",
  rescrape: "jobs rescraped",
  move_to_backlog: "jobs moved to Backlog",
  move_to_stale: "jobs moved to Stale",
  move_to_inbox: "jobs moved to Inbox",
  mark_closed: "applications closed",
  mark_duplicated: "duplicates closed",
  reopen: "jobs reopened",
};

// Triage status moves whose prior {status, outcome, closedAt} can be restored.
// Tailor (move_to_ready), rescore and clear_score are excluded — they create or
// destroy PDFs/scores that a status-revert can't cleanly undo (clear_score
// drops the suitability reason, which nothing here retains).
const undoActionLabel: Partial<Record<JobAction, string>> = {
  skip: "Skip",
  move_to_backlog: "Move to Backlog",
  move_to_stale: "Move to Stale",
  move_to_inbox: "Move to Inbox",
  mark_closed: "Close application",
  reopen: "Reopen",
};

interface UseJobSelectionActionsArgs {
  activeJobs: JobListItem[];
  activeTab: FilterTab;
  loadJobs: () => Promise<void>;
  maxBulkActionJobs: number;
  pushUndo?: (entry: { label: string; restore: () => Promise<void> }) => void;
  undo?: () => void;
}

export function useJobSelectionActions({
  activeJobs,
  activeTab,
  loadJobs,
  maxBulkActionJobs,
  pushUndo,
  undo,
}: UseJobSelectionActionsArgs) {
  // Always-fresh view of the list so the streaming callback (whose useCallback
  // deps deliberately omit activeJobs) can snapshot pre-action state.
  const activeJobsRef = useRef(activeJobs);
  activeJobsRef.current = activeJobs;
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [jobActionInFlight, setJobActionInFlight] = useState<null | JobAction>(
    null,
  );
  const previousActiveTabRef = useRef<FilterTab>(activeTab);
  // Anchor for shift-click range selection. Tracks the last single-toggled
  // row; the next shift-click extends the selection from the anchor to the
  // target (additive — never deselects).
  const rangeAnchorRef = useRef<string | null>(null);

  const selectedJobs = useMemo(
    () => activeJobs.filter((job) => selectedJobIds.has(job.id)),
    [activeJobs, selectedJobIds],
  );

  const canSkipSelected = useMemo(() => canSkip(selectedJobs), [selectedJobs]);
  const canMoveSelected = useMemo(
    () => canMoveToReady(selectedJobs),
    [selectedJobs],
  );
  const canRescoreSelected = useMemo(
    () => canRescore(selectedJobs),
    [selectedJobs],
  );
  const canClearScoreSelected = useMemo(
    () => canClearScore(selectedJobs),
    [selectedJobs],
  );
  const canRescrapeSelected = useMemo(
    () => canRescrape(selectedJobs),
    [selectedJobs],
  );
  const canMoveToBacklogSelected = useMemo(
    () => canMoveToBacklog(selectedJobs),
    [selectedJobs],
  );
  const canMoveToStaleSelected = useMemo(
    () => canMoveToStale(selectedJobs),
    [selectedJobs],
  );
  const canMoveToInboxSelected = useMemo(
    () => canMoveToInbox(selectedJobs),
    [selectedJobs],
  );
  const canMarkClosedSelected = useMemo(
    () => canMarkClosed(selectedJobs),
    [selectedJobs],
  );
  const canReopenSelected = useMemo(
    () => canReopen(selectedJobs),
    [selectedJobs],
  );

  useEffect(() => {
    if (previousActiveTabRef.current === activeTab) return;
    previousActiveTabRef.current = activeTab;
    setSelectedJobIds(new Set());
    rangeAnchorRef.current = null;
  }, [activeTab]);

  useEffect(() => {
    const activeJobIdSet = new Set(activeJobs.map((job) => job.id));
    setSelectedJobIds((previous) => {
      if (previous.size === 0) return previous;
      const next = new Set(
        Array.from(previous).filter((jobId) => activeJobIdSet.has(jobId)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [activeJobs]);

  const toggleSelectJob = useCallback(
    (jobId: string, options?: { range?: boolean }) => {
      const anchor = rangeAnchorRef.current;
      const canRange = options?.range === true && anchor !== null;
      if (canRange) {
        const ids = activeJobs.map((job) => job.id);
        const anchorIndex = ids.indexOf(anchor as string);
        const targetIndex = ids.indexOf(jobId);
        if (anchorIndex !== -1 && targetIndex !== -1) {
          const [lo, hi] =
            anchorIndex < targetIndex
              ? [anchorIndex, targetIndex]
              : [targetIndex, anchorIndex];
          const sliceIds = ids.slice(lo, hi + 1);
          setSelectedJobIds((previous) => {
            const next = new Set(previous);
            for (const id of sliceIds) next.add(id);
            return next;
          });
          // Keep the anchor where it was so successive shift-clicks extend
          // from the original starting point, matching Gmail / Finder UX.
          return;
        }
        // Anchor no longer in the active view — fall through to single toggle.
      }

      setSelectedJobIds((previous) => {
        const next = new Set(previous);
        if (next.has(jobId)) {
          next.delete(jobId);
        } else {
          next.add(jobId);
        }
        return next;
      });
      rangeAnchorRef.current = jobId;
    },
    [activeJobs],
  );

  const toggleSelectAll = useCallback(
    (checked: boolean) => {
      setSelectedJobIds(() => {
        if (!checked) return new Set();
        const allIds = activeJobs.map((job) => job.id);
        if (allIds.length <= maxBulkActionJobs) {
          return new Set(allIds);
        }
        toast.error(
          `Select all is limited to ${maxBulkActionJobs} jobs per action.`,
        );
        return new Set(allIds.slice(0, maxBulkActionJobs));
      });
    },
    [activeJobs, maxBulkActionJobs],
  );

  const clearSelection = useCallback(() => {
    setSelectedJobIds(new Set());
    rangeAnchorRef.current = null;
  }, []);

  const runStreamingAction = useCallback(
    async (request: JobActionRequest) => {
      const action = request.action;
      const selectedAtStart = request.jobIds;
      if (selectedAtStart.length === 0) return;
      if (selectedAtStart.length > maxBulkActionJobs) {
        toast.error(
          `You can run job actions on up to ${maxBulkActionJobs} jobs at a time.`,
        );
        return;
      }

      const selectedAtStartSet = new Set(selectedAtStart);
      // Snapshot pre-action state for undoable triage moves (before the action
      // mutates the rows), keyed off the always-fresh list ref.
      const undoLabel = undoActionLabel[action];
      const preSnapshots: JobStateSnapshot[] = undoLabel
        ? activeJobsRef.current
            .filter((job) => selectedAtStartSet.has(job.id))
            .map(snapshotJob)
        : [];
      let progressToastId: string | number | undefined;
      let finalResult: JobActionResponse | null = null;
      let streamError: string | null = null;
      let latestProgress = {
        requested: selectedAtStart.length,
        completed: 0,
        succeeded: 0,
        failed: 0,
      };

      const getProgressTitle = () => {
        const safeRequested = Math.max(latestProgress.requested, 1);
        const safeCompleted = clampNumber(
          latestProgress.completed,
          0,
          safeRequested,
        );
        return `${safeCompleted}/${safeRequested} ${jobActionLabel[action]}`;
      };

      const upsertProgressToast = () => {
        progressToastId = toast.loading(getProgressTitle(), {
          description: (
            <JobActionProgressToast
              requested={latestProgress.requested}
              completed={latestProgress.completed}
              succeeded={latestProgress.succeeded}
              failed={latestProgress.failed}
            />
          ),
          ...(progressToastId !== undefined ? { id: progressToastId } : {}),
          duration: Number.POSITIVE_INFINITY,
        });
      };

      try {
        setJobActionInFlight(action);
        upsertProgressToast();
        await api.streamJobAction(request, {
          onEvent: (event) => {
            if (event.type === "error") {
              streamError = event.message || "Failed to run job action";
              return;
            }

            if (event.type === "started") {
              latestProgress = {
                requested: event.requested,
                completed: event.completed,
                succeeded: event.succeeded,
                failed: event.failed,
              };
              upsertProgressToast();
              return;
            }

            if (event.type === "progress") {
              latestProgress = {
                requested: event.requested,
                completed: event.completed,
                succeeded: event.succeeded,
                failed: event.failed,
              };
              upsertProgressToast();
              return;
            }

            latestProgress = {
              requested: event.requested,
              completed: event.completed,
              succeeded: event.succeeded,
              failed: event.failed,
            };
            finalResult = {
              action: event.action,
              requested: event.requested,
              succeeded: event.succeeded,
              failed: event.failed,
              results: event.results,
            };
            upsertProgressToast();
          },
        });

        if (streamError) {
          throw new Error(streamError);
        }

        if (!finalResult) {
          throw new Error("Job action stream ended before completion");
        }

        const result = finalResult as JobActionResponse;
        const failedIds = getFailedJobIds(result);
        const successLabel = jobActionSuccessLabel[action];

        // Register undo for the rows that actually changed.
        const undoSnapshots = preSnapshots.filter(
          (snap) => !failedIds.has(snap.jobId),
        );
        const undoAction =
          undoLabel && undoSnapshots.length > 0
            ? { label: "Undo", onClick: () => undo?.() }
            : undefined;
        if (pushUndo && undoLabel && undoSnapshots.length > 0) {
          pushUndo({
            label: `${undoLabel} (${undoSnapshots.length})`,
            restore: async () => {
              await restoreJobStates(undoSnapshots);
            },
          });
        }

        if (result.failed === 0) {
          toast.success(
            `${result.succeeded} ${successLabel}`,
            undoAction ? { action: undoAction } : undefined,
          );
        } else {
          const firstFailure = result.results.find(
            (entry): entry is Extract<typeof entry, { ok: false }> =>
              entry.ok === false,
          );
          const detail = firstFailure?.error?.message?.trim();
          const truncated =
            detail && detail.length > 200
              ? `${detail.slice(0, 200)}…`
              : detail;
          toast.error(
            `${result.succeeded} succeeded, ${result.failed} failed.${
              truncated ? ` First error: ${truncated}` : ""
            }`,
            undoAction ? { action: undoAction } : undefined,
          );
        }

        await loadJobs();
        setSelectedJobIds((current) => {
          const addedDuringRequest = Array.from(current).filter(
            (jobId) => !selectedAtStartSet.has(jobId),
          );
          const removedDuringRequest = Array.from(selectedAtStartSet).filter(
            (jobId) => !current.has(jobId),
          );
          const next = new Set([
            ...Array.from(failedIds),
            ...addedDuringRequest,
          ]);
          for (const jobId of removedDuringRequest) next.delete(jobId);
          return next;
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to run job action";
        toast.error(message);
      } finally {
        if (progressToastId !== undefined) {
          toast.dismiss(progressToastId);
        }
        setJobActionInFlight(null);
      }
    },
    [loadJobs, maxBulkActionJobs, pushUndo, undo],
  );

  // Option-less variants. mark_closed needs an outcome and goes through
  // runMarkClosedAction below.
  const runJobAction = useCallback(
    async (action: Exclude<JobAction, "mark_closed">) => {
      const jobIds = Array.from(selectedJobIds);
      if (jobIds.length === 0) return;
      await runStreamingAction({ action, jobIds } as JobActionRequest);
    },
    [selectedJobIds, runStreamingAction],
  );

  const runMarkClosedAction = useCallback(
    async (outcome: JobOutcome) => {
      const jobIds = Array.from(selectedJobIds);
      if (jobIds.length === 0) return;
      await runStreamingAction({
        action: "mark_closed",
        jobIds,
        options: { outcome },
      });
    },
    [selectedJobIds, runStreamingAction],
  );

  return {
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
    jobActionInFlight,
    toggleSelectJob,
    toggleSelectAll,
    clearSelection,
    runJobAction,
    runMarkClosedAction,
  };
}
