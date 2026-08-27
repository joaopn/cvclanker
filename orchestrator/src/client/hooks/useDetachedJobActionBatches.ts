import {
  getJobActionBatchSnapshots,
  isOwnJobActionBatch,
  refreshJobActionBatches,
  subscribeToJobActionBatches,
} from "@client/lib/job-action-batches";
import { toast } from "@client/lib/toast";
import type { JobActionBatchSnapshot } from "@shared/types";
import { useEffect, useRef } from "react";

/**
 * Surfaces bulk actions started somewhere else — the point of detaching them:
 * fire a sweep from a phone, close it, and pick the run up on a desktop.
 *
 * Deliberately shows nothing for a batch that was ALREADY finished when this
 * tab first saw it. The server retains the last fifty finished batches, so
 * surfacing those would pop fifty summaries on every page load, and again on
 * every stream reconnect. The cost is that a batch which finishes while you
 * have no tab open is silent — its results are in the job rows either way.
 */
export function useDetachedJobActionBatches(): void {
  const progressToasts = useRef(new Map<string, string | number>());

  useEffect(() => {
    const toastIds = progressToasts.current;

    const describe = (batch: JobActionBatchSnapshot) =>
      `${batch.completed}/${batch.requested} · started elsewhere`;

    const sync = () => {
      const snapshots = getJobActionBatchSnapshots();

      // A batch can leave the list without ever going terminal — the server
      // lost it. Nothing else clears these toasts, and they are rendered with
      // an infinite duration, so a spinner for dead work would sit there until
      // the user changed route.
      const live = new Set(snapshots.map((batch) => batch.batchId));
      let lost = 0;
      for (const [batchId, id] of [...toastIds]) {
        if (live.has(batchId)) continue;
        toast.dismiss(id);
        toastIds.delete(batchId);
        lost += 1;
      }
      // One notice however many went, since they all go together — a restart
      // takes every watched batch with it.
      if (lost > 0) {
        toast.warning(
          lost === 1
            ? "Lost track of a bulk action started elsewhere."
            : `Lost track of ${lost} bulk actions started elsewhere.`,
        );
      }

      for (const batch of snapshots) {
        if (isOwnJobActionBatch(batch.batchId)) continue;

        if (batch.status === "running") {
          const existing = toastIds.get(batch.batchId);
          const id = toast.loading(describe(batch), {
            ...(existing !== undefined ? { id: existing } : {}),
            duration: Number.POSITIVE_INFINITY,
          });
          toastIds.set(batch.batchId, id);
          continue;
        }

        // Terminal. Only report it if this tab watched it running — otherwise
        // it is history the snapshot happens to still be carrying.
        const existing = toastIds.get(batch.batchId);
        if (existing === undefined) continue;
        toast.dismiss(existing);
        toastIds.delete(batch.batchId);
        if (batch.failed === 0) {
          toast.success(`${batch.succeeded} of ${batch.requested} done`);
        } else {
          toast.error(
            `${batch.succeeded} succeeded, ${batch.failed} failed elsewhere.`,
          );
        }
      }
    };

    const discover = () => {
      void refreshJobActionBatches().catch(() => {
        // A failed discovery poll is not worth a toast; the next signal retries.
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") discover();
    };

    discover();
    const unsubscribe = subscribeToJobActionBatches(sync);
    window.addEventListener("focus", discover);
    window.addEventListener("online", discover);
    // iOS fires this and not always `focus` when a backgrounded tab comes
    // back — which is exactly the "pick it up on the other device" moment.
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      unsubscribe();
      window.removeEventListener("focus", discover);
      window.removeEventListener("online", discover);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const id of toastIds.values()) toast.dismiss(id);
      toastIds.clear();
    };
  }, []);
}
