import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { useQuery } from "@tanstack/react-query";

/**
 * On-demand fetch of active-triage jobs grouped by the board's own posting id.
 * Backs the duplicate-review banner + modal. Kept out of the hot job-list path;
 * callers refetch after resolution and whenever the job list changes.
 */
export function useDuplicateGroups() {
  const query = useQuery({
    queryKey: queryKeys.jobs.duplicates(),
    queryFn: () => api.getDuplicateGroups(),
    staleTime: 30_000,
  });

  return {
    groups: query.data?.groups ?? [],
    count: query.data?.groups.length ?? 0,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
