/**
 * Data + action layer for the mobile Swipe deck.
 *
 * Fetches the discovered-job inbox as FULL jobs (the fit assessment and the
 * description are the card's centerpiece, and JobListItem omits both), orders
 * them fit-first, and exposes an optimistic `act()` that drives the existing
 * `POST /api/jobs/actions` dispatcher with a single jobId.
 */

import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import { useQuery } from "@tanstack/react-query";
import type { Job, SuitabilityCategory } from "@shared/types.js";
import { useCallback, useEffect, useState } from "react";

/** Actions reachable from the deck — all accept a `discovered` source job. */
export type SwipeAction = "move_to_ready" | "skip" | "move_to_backlog";

const FIT_RANK: Record<SuitabilityCategory, number> = {
  great_fit: 0,
  very_good_fit: 1,
  good_fit: 2,
  bad_fit: 3,
};

/** Best-effort ms timestamp; tolerates ISO or all-digit Unix-ms strings. */
const dateMs = (value: string | null): number => {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

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
}

export interface UseSwipeDeckResult {
  cards: Job[];
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
}: UseSwipeDeckArgs): UseSwipeDeckResult {
  // Jobs the user has already swiped this session — hidden optimistically so
  // the card leaves immediately, before the network round-trip resolves.
  const [committed, setCommitted] = useState<Set<string>>(() => new Set());
  // The most recent successfully-swiped job, available for a single-level undo.
  const [lastSwipe, setLastSwipe] = useState<Job | null>(null);

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

  const act = useCallback(async (job: Job, action: SwipeAction) => {
    setCommitted((prev) => new Set(prev).add(job.id));

    let failed = false;
    try {
      await api.streamJobAction(
        { action, jobIds: [job.id] },
        {
          onEvent: (event) => {
            if (event.type === "progress" && !event.result.ok) failed = true;
            if (event.type === "error") failed = true;
          },
        },
      );
    } catch {
      failed = true;
    }

    if (failed) {
      // Roll back: surface the card again so the user can retry.
      setCommitted((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      toast.error(`Couldn't update "${job.title}"`);
      return;
    }

    // Tailoring runs in the background and resolves the row to ready; a PATCH
    // back to discovered would race it. Exclude it from undo (skip/backlog
    // only), matching the Manage view.
    if (action !== "move_to_ready") setLastSwipe(job);
  }, []);

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
    isLoading: query.isLoading,
    isError: query.isError,
    act,
    canUndo: lastSwipe !== null,
    undo,
    refetch: () => query.refetch(),
  };
}
