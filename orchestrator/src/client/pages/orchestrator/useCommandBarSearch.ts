import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { JobCommandBarResults } from "./JobCommandBar";
import type { CommandBarLock } from "./JobCommandBar.utils";

type CommandBarSearch = { query: string; lock: CommandBarLock | null };

/**
 * The ctrl+K search's server half: one request per change of text or lock,
 * only while the dialog is open.
 *
 * Every answer carries the search it answers — that tag is the only way the
 * dialog can tell a stale answer from a current one, so it is attached here,
 * where the request is made, rather than inferred from timing. The previous
 * answer stays in `results` while the next is in flight, and also after the
 * next one fails: react-query drops a placeholder once its query errors, which
 * would otherwise empty the dialog.
 */
export function useCommandBarSearch(isOpen: boolean): {
  results: JobCommandBarResults | null;
  searchFailed: boolean;
  searchPending: boolean;
  onSearchChange: (search: CommandBarSearch) => void;
} {
  const [search, setSearch] = useState<CommandBarSearch>({
    query: "",
    lock: null,
  });
  const { data, isError, isFetching } = useQuery({
    queryKey: queryKeys.jobs.search(search),
    queryFn: async (): Promise<JobCommandBarResults> => ({
      ...(await api.searchJobs(search)),
      ...search,
    }),
    enabled: isOpen,
    placeholderData: keepPreviousData,
    // Asked again on every open, rather than after the app-wide staleTime, so
    // a triage move made outside the dialog shows up. The cached answer stays
    // on screen meanwhile, and `searchPending` keeps Enter from selecting a
    // job by its old status — which is also the tab it would open.
    staleTime: 0,
  });
  const lastAnswer = useRef<JobCommandBarResults | null>(null);
  if (data) lastAnswer.current = data;
  return {
    results: data ?? lastAnswer.current,
    searchFailed: isError,
    searchPending: isFetching,
    onSearchChange: setSearch,
  };
}
