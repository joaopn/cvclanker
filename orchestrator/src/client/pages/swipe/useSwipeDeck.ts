/**
 * Data + action layer for the mobile Swipe deck.
 *
 * Fetches the discovered-job inbox as FULL jobs (the fit assessment and the
 * description are the card's centerpiece, and JobListItem omits both), orders
 * them fit-first, and exposes an optimistic `act()` that drives the existing
 * `POST /api/jobs/actions` dispatcher with a single jobId.
 */

import * as api from "@client/api";
import {
  startJobActionBatch,
  watchJobActionBatch,
} from "@client/lib/job-action-batches";
import { toast } from "@client/lib/toast";
import { useQuery } from "@tanstack/react-query";
import type { Job, SuitabilityCategory } from "@shared/types.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConfirmTailor,
  tailorApproved,
} from "../orchestrator/tailorCompanyConflicts";
import { dateValue } from "../orchestrator/utils";

/** Actions reachable from the deck — all accept a `discovered` source job. */
export type SwipeAction = "move_to_ready" | "skip" | "move_to_backlog";

const FIT_RANK: Record<SuitabilityCategory, number> = {
  great_fit: 0,
  very_good_fit: 1,
  good_fit: 2,
  bad_fit: 3,
};

/** The shared date read, with an unknown date sorted as the epoch. */
const dateMs = (value: string | null): number => dateValue(value) ?? 0;

/** Fit-first, then newest-posted first. */
const byFitThenDate = (a: Job, b: Job): number => {
  const ra = a.suitabilityCategory ? FIT_RANK[a.suitabilityCategory] : 4;
  const rb = b.suitabilityCategory ? FIT_RANK[b.suitabilityCategory] : 4;
  if (ra !== rb) return ra - rb;
  return dateMs(b.datePosted) - dateMs(a.datePosted);
};

export const SWIPE_DECK_QUERY_KEY = ["swipe-deck", "discovered"] as const;

interface UseSwipeDeckArgs {
  /** Terminal pipeline event from useOrchestratorData; refetches the deck. */
  pipelineTerminalEvent: { status: string; errorMessage: string | null } | null;
  /**
   * While a run is in progress, poll so newly-discovered jobs populate an
   * empty deck. Polling is suppressed once cards exist so an active swipe
   * isn't yanked out from under the user (the final list syncs on the
   * terminal event regardless).
   */
  isPipelineRunning?: boolean;
  /**
   * The duplicate-application guard, applied to the tailor swipe only. Required
   * so a mount cannot silently skip it — the deck is the surface where the user
   * moves fastest and sees the least context about the employer.
   */
  confirmTailor: ConfirmTailor;
}

export interface UseSwipeDeckResult {
  cards: Job[];
  /** True while a tailor swipe is waiting on the duplicate-application guard. */
  tailorPending: boolean;
  isLoading: boolean;
  isError: boolean;
  act: (job: Job, action: SwipeAction) => Promise<void>;
  canUndo: boolean;
  undo: () => Promise<void>;
  refetch: () => void;
}

export function useSwipeDeck({
  pipelineTerminalEvent,
  isPipelineRunning = false,
  confirmTailor,
}: UseSwipeDeckArgs): UseSwipeDeckResult {
  // Jobs the user has already swiped this session — hidden optimistically so
  // the card leaves immediately, before the network round-trip resolves.
  const [committed, setCommitted] = useState<Set<string>>(() => new Set());
  // The most recent successfully-swiped job, available for a single-level undo.
  const [lastSwipe, setLastSwipe] = useState<Job | null>(null);
  // A tailor swipe is parked on the guard. The ref is the decision-maker (state
  // cannot be read back in the same tick, and the card is draggable for the
  // whole fetch); the state only drives the action bar's disabled look.
  const tailorPendingRef = useRef(false);
  const [tailorPending, setTailorPending] = useState(false);

  const query = useQuery({
    queryKey: SWIPE_DECK_QUERY_KEY,
    queryFn: async () => {
      const data = await api.getJobs({
        statuses: ["discovered"],
        view: "full",
      });
      return data.jobs;
    },
    // Populate an empty deck live during a run; don't poll once cards exist.
    refetchInterval: (query) =>
      isPipelineRunning && (query.state.data?.length ?? 0) === 0 ? 3000 : false,
  });

  // Refetch when a pipeline run terminates (new discovered jobs may exist).
  useEffect(() => {
    if (!pipelineTerminalEvent) return;
    if (pipelineTerminalEvent.status === "completed") {
      setCommitted(new Set());
      query.refetch();
    }
  }, [pipelineTerminalEvent, query.refetch]);

  const cards = (query.data ?? [])
    .filter((job) => !committed.has(job.id))
    .sort(byFitThenDate);

  const act = useCallback(
    async (job: Job, action: SwipeAction) => {
      // Refuse a second tailor BEFORE committing anything. The UI also stops
      // the gesture reaching here (`SwipeCard` is frozen while a tailor is
      // parked), so this is the hook's own invariant rather than the visible
      // behaviour — and refusing pre-commit means the deck never churns.
      if (action === "move_to_ready" && tailorPendingRef.current) return;

      setCommitted((prev) => new Set(prev).add(job.id));

      const rollBack = () =>
        setCommitted((prev) => {
          const next = new Set(prev);
          next.delete(job.id);
          return next;
        });

      if (action === "move_to_ready") {
        // The dialog only mounts once the fetch resolves AND finds a conflict,
        // so the whole round trip is unguarded input. A second tailor swipe in
        // that window used to reach the guard too, whose "a newer press cancels
        // the older" rule then resolved the FIRST press null — the first card
        // silently un-swiped itself and the box that appeared was about the
        // second. The reachable trigger is two cards at one employer, i.e.
        // exactly what this feature is for.
        tailorPendingRef.current = true;
        setTailorPending(true);
        let approved = false;
        try {
          approved = await tailorApproved(confirmTailor, job);
        } catch {
          // Both callers are fire-and-forget, so a throwing guard would escape
          // as an unhandled rejection AND strand the card in `committed` with
          // no rollback. Treat it as a refusal: the card comes back and the
          // user can retry.
          approved = false;
        } finally {
          tailorPendingRef.current = false;
          setTailorPending(false);
        }
        if (!approved) {
          // No toast: the user cancelled deliberately. That is the whole
          // difference between this and the failure branch below.
          rollBack();
          return;
        }
      }

      let failed = false;
      try {
        // Detached like every other bulk action, so a swipe survives the tab
        // closing mid-flight ONCE DISPATCHED — with the guard on, closing the
        // deck while the box is open cancels instead, which is right: the user
        // never answered. Awaited all the same: the deck rolls the card back on
        // failure, so it needs the outcome.
        const batchId = await startJobActionBatch({ action, jobIds: [job.id] });
        const final = await watchJobActionBatch(batchId);
        if (final.failed > 0 || final.status !== "completed") failed = true;
      } catch {
        failed = true;
      }

      if (failed) {
        // Roll back: surface the card again so the user can retry.
        rollBack();
        toast.error(`Couldn't update "${job.title}"`);
        return;
      }

      // Tailoring runs in the background and resolves the row to ready; a PATCH
      // back to discovered would race it. Exclude it from undo (skip/backlog
      // only), matching the Manage view.
      if (action !== "move_to_ready") setLastSwipe(job);
    },
    [confirmTailor],
  );

  const undo = useCallback(async () => {
    if (!lastSwipe) return;
    try {
      await api.updateJob(lastSwipe.id, {
        status: "discovered",
        outcome: null,
        closedAt: null,
      });
    } catch {
      toast.error(`Couldn't undo "${lastSwipe.title}"`);
      return;
    }
    // Drop it from `committed` so the refetched card re-enters the deck.
    setCommitted((prev) => {
      const next = new Set(prev);
      next.delete(lastSwipe.id);
      return next;
    });
    setLastSwipe(null);
    await query.refetch();
  }, [lastSwipe, query.refetch]);

  return {
    cards,
    tailorPending,
    isLoading: query.isLoading,
    isError: query.isError,
    act,
    canUndo: lastSwipe !== null,
    undo,
    refetch: () => query.refetch(),
  };
}
