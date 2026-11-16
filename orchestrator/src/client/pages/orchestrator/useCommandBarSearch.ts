import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { JobCommandBarResults } from "./JobCommandBar";
import type { CommandBarLock } from "./JobCommandBar.utils";

type CommandBarSearch = { query: string; lock: CommandBarLock | null };

const EMPTY_SEARCH: CommandBarSearch = { query: "", lock: null };

/**
 * The ctrl+K search's server half: one request per submitted search, only
 * while the dialog is open. `null` means nothing is submitted, and nothing is
 * asked.
 *
 * Every answer carries the search it answers — that tag is the only way the
 * dialog can tell a stale answer from a current one, so it is attached here,
 * where the request is made, rather than inferred from timing. The previous
 * answer stays in `results` while the next is in flight, and also after the
 * next one fails: react-query drops a placeholder once its query errors, which
 * would otherwise lose it.
 *
 * Submitting the search already submitted asks the server again rather than
 * doing nothing: the press was explicit, and the jobs may have moved since.
 * While that search is still being asked, a repeat is ignored: the server
 * cannot cancel the running query, so a second request only adds load.
 */
export function useCommandBarSearch(isOpen: boolean): {
  results: JobCommandBarResults | null;
  searchFailed: boolean;
  searchPending: boolean;
  onSearchChange: (search: CommandBarSearch | null) => void;
} {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState<CommandBarSearch | null>(null);
  const searchRef = useRef(search);
  searchRef.current = search;
  const asked = search ?? EMPTY_SEARCH;
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: queryKeys.jobs.search(asked),
    queryFn: async (): Promise<JobCommandBarResults> => ({
      ...(await api.searchJobs(asked)),
      ...asked,
    }),
    enabled: isOpen && search !== null,
    placeholderData: keepPreviousData,
    // A submit of a search answered before (this session, or before a close)
    // asks again rather than trusting the app-wide staleTime, so a triage move
    // made outside the dialog shows up. The cached answer stays on screen
    // meanwhile, and `searchPending` keeps Enter from selecting a job by its
    // old status — which is also the tab it would open.
    staleTime: 0,
  });
  const lastAnswer = useRef<JobCommandBarResults | null>(null);
  if (data) lastAnswer.current = data;

  const onSearchChange = useCallback(
    (next: CommandBarSearch | null) => {
      const current = searchRef.current;
      if (
        next !== null &&
        current !== null &&
        next.query === current.query &&
        next.lock === current.lock
      ) {
        // Read from the cache, not from a render: react-query reports a fetch
        // to React a tick after it starts, and a second press can land first.
        const running =
          queryClient.getQueryState(queryKeys.jobs.search(current))
            ?.fetchStatus === "fetching";
        if (running) return;
        void refetch();
        return;
      }
      setSearch(next);
    },
    [queryClient, refetch],
  );

  return {
    results: data ?? lastAnswer.current,
    searchFailed: search !== null && isError,
    searchPending: search !== null && isFetching,
    onSearchChange,
  };
}
