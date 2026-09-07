/**
 * The stateful half of the tailor-time duplicate-application guard: asks the
 * server what is already in flight, decides whether anything clashes, and — if
 * it does — parks the press on a promise until the user answers the dialog.
 */

import * as api from "@client/api";
import { queryClient } from "@client/lib/queryClient";
import { queryKeys } from "@client/lib/queryKeys";
import { toast } from "@client/lib/toast";
import type { JobListItem } from "@shared/types.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildCompanyConflicts,
  type CompanyConflictGroup,
  type ConfirmTailor,
  IN_FLIGHT_STATUSES,
  nonConflictingIds,
  type TailorCandidate,
} from "./tailorCompanyConflicts";

export interface TailorGuardPrompt {
  groups: CompanyConflictGroup[];
  /** Every id the press asked for. */
  allIds: string[];
  /** The subset no group claims — empty when every selected job clashes. */
  safeIds: string[];
}

export interface TailorCompanyGuard {
  confirmTailor: ConfirmTailor;
  /** The open prompt, or null. Render the dialog from this. */
  prompt: TailorGuardPrompt | null;
  /** Resolve the open prompt. `null` cancels the press entirely. */
  resolvePrompt: (ids: string[] | null) => void;
}

export function useTailorCompanyGuard(enabled: boolean): TailorCompanyGuard {
  const [prompt, setPrompt] = useState<TailorGuardPrompt | null>(null);
  const pendingRef = useRef<((ids: string[] | null) => void) | null>(null);

  // `confirmTailor` is rebuilt whenever `enabled` flips, and a stale closure
  // would keep checking (or keep not checking) after a settings save.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const settle = useCallback((ids: string[] | null) => {
    const resolve = pendingRef.current;
    pendingRef.current = null;
    setPrompt(null);
    resolve?.(ids);
  }, []);

  // A press left unanswered because the page went away must not leave its
  // caller awaiting for ever — the toast/spinner it owns would never clear.
  // The flag covers the wider window: an unmount DURING the fetch has nothing
  // pending to release yet, and without it the promise created afterwards
  // would install a resolver on a dead tree that nothing can ever call.
  const unmountedRef = useRef(false);
  useEffect(
    () => () => {
      unmountedRef.current = true;
      pendingRef.current?.(null);
    },
    [],
  );

  const confirmTailor = useCallback(
    async (jobs: readonly TailorCandidate[]): Promise<string[] | null> => {
      const ids = jobs.map((job) => job.id);
      if (!enabledRef.current || ids.length === 0) return ids;

      let inFlight: JobListItem[];
      try {
        // staleTime 0: the whole value of this check is that it is fresh, and a
        // press is user-initiated and rare. fetchQuery (not a useQuery) because
        // the read happens inside an event handler, not a render.
        const response = await queryClient.fetchQuery({
          queryKey: queryKeys.jobs.inFlight(),
          queryFn: () => api.getJobs({ statuses: [...IN_FLIGHT_STATUSES] }),
          staleTime: 0,
        });
        inFlight = response.jobs;
      } catch {
        // Fail OPEN and say so. A guard that cannot read must not become a
        // blocker on a network blip, but silently skipping the check the user
        // switched on would be worse than not having it.
        toast.warning(
          "Couldn't check for other live jobs at these companies — tailoring anyway.",
        );
        return ids;
      }

      const groups = buildCompanyConflicts(jobs, inFlight);
      if (groups.length === 0) return ids;
      // The page went away while we were asking. There is no one to show the
      // box to, so cancel rather than park on a promise nothing can resolve.
      if (unmountedRef.current) return null;

      return new Promise<string[] | null>((resolve) => {
        // A second press while one prompt is open: cancel the older press
        // rather than stranding its promise, and show the newer one.
        pendingRef.current?.(null);
        pendingRef.current = resolve;
        setPrompt({
          groups,
          allIds: ids,
          safeIds: nonConflictingIds(jobs, groups),
        });
      });
    },
    [],
  );

  return { confirmTailor, prompt, resolvePrompt: settle };
}
