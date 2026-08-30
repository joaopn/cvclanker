import * as api from "@client/api";
import { useDetachedJobActionBatches } from "@client/hooks/useDetachedJobActionBatches";
import { subscribeToPipelineProgress } from "@client/lib/progress-stream";
import { toast } from "@client/lib/toast";
import type {
  Job,
  JobListItem,
  JobStatus,
  JobsListResponse,
} from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { queryKeys } from "@/client/lib/queryKeys";

const initialStats: Record<JobStatus, number> = {
  discovered: 0,
  selected: 0,
  processing: 0,
  ready: 0,
  applied: 0,
  in_progress: 0,
  backlog: 0,
  stale: 0,
  skipped: 0,
  closed: 0,
};

const isDocumentVisible = () =>
  typeof document === "undefined" || document.visibilityState === "visible";

type PipelineProgressStep =
  | "idle"
  | "crawling"
  | "importing"
  | "scoring"
  | "live_status"
  | "processing"
  | "completed"
  | "cancelled"
  | "failed";

type PipelineProgressEvent = {
  step: PipelineProgressStep;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /**
   * Present while a multi-profile run is in flight. Its presence means the
   * event belongs to ONE profile of a chain, so the chain itself is still
   * running whatever this event's step says.
   */
  profileRun?: {
    id: string;
    name: string;
    index: number;
    total: number;
  } | null;
};

type PipelineTerminalStatus = "completed" | "cancelled" | "failed";

type PipelineTerminalEvent = {
  status: PipelineTerminalStatus;
  errorMessage: string | null;
  token: number;
};

type PipelineTerminalSnapshot = {
  status: PipelineTerminalStatus;
  errorMessage: string | null;
  signature: string;
};

const ACTIVE_PIPELINE_STEPS: ReadonlySet<PipelineProgressStep> = new Set([
  "crawling",
  "importing",
  "scoring",
  // A step missing here is not merely unlabelled: the event filter below drops
  // an unknown step entirely, so a tab that MOUNTS during it would never set
  // `isPipelineRunning` and would offer an unlocked Run button and no Cancel
  // for the minutes the step lasts.
  "live_status",
  "processing",
]);

const TERMINAL_PIPELINE_STEPS: ReadonlySet<PipelineProgressStep> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

const buildTerminalSignature = ({
  status,
  startedAt,
  completedAt,
  runId,
}: {
  status: PipelineTerminalStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  runId?: string | null;
}) => {
  if (startedAt || completedAt) {
    return `${status}:${startedAt ?? ""}:${completedAt ?? ""}`;
  }
  return `${status}:run:${runId ?? "unknown"}`;
};

export const useOrchestratorData = (
  selectedJobId: string | null,
  needsFullView = false,
  // Statuses this surface displays. The hook fetches ONLY these rows (the
  // server filters them), so terminal shelves don't ride along on every
  // refresh of a 20k-row database. Undefined = unscoped (the All tab).
  // Callers must keep the array's identity stable (useMemo / module const).
  scopeStatuses?: JobStatus[],
) => {
  const queryClient = useQueryClient();
  const [jobListItems, setJobListItems] = useState<JobListItem[]>([]);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [stats, setStats] = useState<Record<JobStatus, number>>(initialStats);
  const [isLoading, setIsLoading] = useState(true);
  const [isPipelineRunning, setIsPipelineRunning] = useState(false);
  const [isPipelineSseConnected, setIsPipelineSseConnected] = useState(false);
  const [pipelineTerminalEvent, setPipelineTerminalEvent] =
    useState<PipelineTerminalEvent | null>(null);
  const [isRefreshPaused, setIsRefreshPaused] = useState(false);
  const requestSeqRef = useRef(0);
  const needsFullViewRef = useRef(needsFullView);
  const latestAppliedSeqRef = useRef(0);
  const pendingLoadCountRef = useRef(0);
  const selectedJobRequestSeqRef = useRef(0);
  const selectedJobCacheRef = useRef<Map<string, Job>>(new Map());
  // Revision tokens are scope-relative (the server embeds the status
  // filter), so remember which scope produced the one we hold.
  const lastRevisionRef = useRef<{
    scopeKey: string;
    revision: string;
  } | null>(null);
  // Updated during render so the interval/SSE callbacks always read the
  // current scope without tearing down their subscriptions on tab switches.
  const scopeKey =
    scopeStatuses && scopeStatuses.length > 0
      ? [...scopeStatuses].sort().join(",")
      : "all";
  const scopeRef = useRef<JobStatus[] | undefined>(undefined);
  scopeRef.current =
    scopeStatuses && scopeStatuses.length > 0 ? scopeStatuses : undefined;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  // What the fetch effect last acted on, so it can tell a scope change from a
  // full-view flip and handle both in one place.
  const prevScopeKeyRef = useRef<string | null>(null);
  // Last successful payload per scope: a previously visited tab renders
  // instantly from here while a background revalidation runs.
  const scopeCacheRef = useRef<
    Map<
      string,
      {
        seq: number;
        data: JobsListResponse<Job> | JobsListResponse<JobListItem>;
      }
    >
  >(new Map());
  const lastSseRefreshAtRef = useRef(0);
  const hasHydratedPipelineStateRef = useRef(false);
  const seenRunningThisSessionRef = useRef(false);
  const baselineTerminalSignatureRef = useRef<string | null>(null);
  const lastTerminalSignatureRef = useRef<string | null>(null);
  const terminalEventTokenRef = useRef(0);

  const publishPipelineTerminal = useCallback(
    (status: PipelineTerminalStatus, errorMessage: string | null) => {
      terminalEventTokenRef.current += 1;
      setPipelineTerminalEvent({
        status,
        errorMessage,
        token: terminalEventTokenRef.current,
      });
    },
    [],
  );

  const observePipelineState = useCallback(
    (snapshot: {
      isRunning: boolean;
      terminal: PipelineTerminalSnapshot | null;
    }) => {
      setIsPipelineRunning(snapshot.isRunning);
      if (snapshot.isRunning) {
        seenRunningThisSessionRef.current = true;
      }

      if (!snapshot.terminal) {
        if (!hasHydratedPipelineStateRef.current) {
          hasHydratedPipelineStateRef.current = true;
        }
        return;
      }

      const signature = snapshot.terminal.signature;
      const isFirstPipelineObservation = !hasHydratedPipelineStateRef.current;

      if (isFirstPipelineObservation) {
        hasHydratedPipelineStateRef.current = true;
        baselineTerminalSignatureRef.current = signature;
        lastTerminalSignatureRef.current = signature;
        return;
      }

      if (signature === lastTerminalSignatureRef.current) {
        return;
      }

      lastTerminalSignatureRef.current = signature;
      if (!seenRunningThisSessionRef.current) {
        return;
      }

      if (signature === baselineTerminalSignatureRef.current) {
        return;
      }

      seenRunningThisSessionRef.current = false;
      publishPipelineTerminal(
        snapshot.terminal.status,
        snapshot.terminal.errorMessage,
      );
    },
    [publishPipelineTerminal],
  );

  const loadSelectedJob = useCallback(
    async (jobId: string) => {
      const seq = ++selectedJobRequestSeqRef.current;
      try {
        const fullJob = await queryClient.fetchQuery({
          queryKey: queryKeys.jobs.detail(jobId),
          queryFn: () => api.getJob(jobId),
          staleTime: 0,
        });
        selectedJobCacheRef.current.set(jobId, fullJob);
        if (
          selectedJobId === jobId &&
          seq === selectedJobRequestSeqRef.current
        ) {
          setSelectedJob(fullJob);
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to load selected job details";
        toast.error(message);
      }
    },
    [queryClient, selectedJobId],
  );

  const loadJobs = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    const requestScopeKey = scopeKeyRef.current;
    const statuses = scopeRef.current;
    pendingLoadCountRef.current += 1;
    try {
      // Spinner only when this scope has nothing cached to show — a scope
      // seen before revalidates silently instead of flashing a loading state.
      if (!scopeCacheRef.current.has(requestScopeKey)) {
        setIsLoading(true);
      }
      // The full payload carries the Tier-2 fields (jobDescription, …) that a
      // full-view facet filters on; fetched only while such a facet is active.
      // Full is a superset of the list item, so the list cache stays valid.
      // Both views are scoped to the statuses this surface displays.
      const data = needsFullViewRef.current
        ? await api.getJobs(
            statuses ? { view: "full", statuses } : { view: "full" },
          )
        : await api.getJobs(
            statuses ? { view: "list", statuses } : { view: "list" },
          );
      queryClient.setQueryData(
        queryKeys.jobs.list(
          statuses ? { view: "list", statuses } : { view: "list" },
        ),
        data,
      );
      // Cache even a response for a scope we've since left — it makes that
      // scope's next visit instant. Guarded per scope by seq so an older
      // response never overwrites a newer one.
      const cachedEntry = scopeCacheRef.current.get(requestScopeKey);
      if (!cachedEntry || seq >= cachedEntry.seq) {
        scopeCacheRef.current.set(requestScopeKey, { seq, data });
      }
      if (
        seq >= latestAppliedSeqRef.current &&
        scopeKeyRef.current === requestScopeKey
      ) {
        latestAppliedSeqRef.current = seq;
        setJobListItems(data.jobs);
        setStats(data.byStatus);
        lastRevisionRef.current = {
          scopeKey: requestScopeKey,
          revision: data.revision,
        };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load jobs";
      toast.error(message);
    } finally {
      pendingLoadCountRef.current = Math.max(
        0,
        pendingLoadCountRef.current - 1,
      );
      if (pendingLoadCountRef.current === 0) {
        setIsLoading(false);
      }
    }
  }, [queryClient]);

  const checkPipelineStatus = useCallback(async () => {
    try {
      const status = await queryClient.fetchQuery({
        queryKey: queryKeys.pipeline.status(),
        queryFn: () => api.getPipelineStatus(),
        staleTime: 0,
      });
      const terminalStatus = status.lastRun?.status;

      if (status.isRunning) {
        observePipelineState({ isRunning: true, terminal: null });
        return;
      }

      if (
        !terminalStatus ||
        !TERMINAL_PIPELINE_STEPS.has(terminalStatus as PipelineProgressStep)
      ) {
        observePipelineState({ isRunning: false, terminal: null });
        return;
      }

      const terminal = terminalStatus as PipelineTerminalStatus;
      observePipelineState({
        isRunning: false,
        terminal: {
          status: terminal,
          errorMessage: status.lastRun?.errorMessage ?? null,
          signature: buildTerminalSignature({
            status: terminal,
            startedAt: status.lastRun?.startedAt ?? null,
            completedAt: status.lastRun?.completedAt ?? null,
            runId: status.lastRun?.id ?? null,
          }),
        },
      });
    } catch {
      // Ignore errors
    }
  }, [observePipelineState, queryClient]);

  const checkForJobChanges = useCallback(async () => {
    if (isRefreshPaused || !isDocumentVisible()) return;
    try {
      const statuses = scopeRef.current;
      const entryScopeKey = scopeKeyRef.current;
      const revision = await queryClient.fetchQuery({
        queryKey: queryKeys.jobs.revision(statuses ? { statuses } : undefined),
        queryFn: () => api.getJobsRevision(statuses ? { statuses } : undefined),
        staleTime: 0,
      });
      // The scope changed while the request was in flight — this token
      // belongs to the old scope; the scope-change effect already refetched.
      if (scopeKeyRef.current !== entryScopeKey) return;
      const previous = lastRevisionRef.current;
      if (previous === null || previous.scopeKey !== entryScopeKey) {
        lastRevisionRef.current = {
          scopeKey: entryScopeKey,
          revision: revision.revision,
        };
        return;
      }
      if (revision.revision !== previous.revision) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.jobs.all,
        });
        await loadJobs();
      }
    } catch {
      // Ignore errors
    }
  }, [isRefreshPaused, loadJobs, queryClient]);

  useEffect(() => {
    void checkPipelineStatus();
  }, [checkPipelineStatus]);

  // ONE effect owns both fetch triggers — the tab scope and the facet bar's
  // full-view need — so a tab switch that also flips the view fires a single
  // correctly-shaped fetch instead of a stale-view fetch plus a correction.
  // A scope this session has seen before paints instantly from the cache (no
  // spinner) while the fetch revalidates in the background; rows and revision
  // only — the cached byStatus aggregate is as old as the last visit, and the
  // stats already on screen are fresher. The refs keep loadJobs' identity
  // stable so the SSE subscription and refresh intervals don't tear down on
  // tab switches or facet toggles (the mount run fetches via the scope arm).
  useEffect(() => {
    const scopeChanged = prevScopeKeyRef.current !== scopeKey;
    const fullViewChanged = needsFullViewRef.current !== needsFullView;
    prevScopeKeyRef.current = scopeKey;
    needsFullViewRef.current = needsFullView;
    if (!scopeChanged && !fullViewChanged) return;
    if (scopeChanged) {
      const cached = scopeCacheRef.current.get(scopeKey);
      if (cached) {
        setJobListItems(cached.data.jobs);
        lastRevisionRef.current = {
          scopeKey,
          revision: cached.data.revision,
        };
      }
    }
    void loadJobs();
  }, [scopeKey, needsFullView, loadJobs]);

  useEffect(() => {
    if (!isPipelineRunning) return;
    seenRunningThisSessionRef.current = true;
  }, [isPipelineRunning]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isDocumentVisible() || isRefreshPaused) return;
      void checkForJobChanges();
    }, 30000);

    return () => clearInterval(interval);
  }, [checkForJobChanges, isRefreshPaused]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isDocumentVisible() || isRefreshPaused) return;
      void loadJobs();
    }, 600000);

    return () => clearInterval(interval);
  }, [isRefreshPaused, loadJobs]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const refreshFromVisibilitySignal = () => {
      if (!isDocumentVisible() || isRefreshPaused) return;
      void checkForJobChanges();
    };

    const onVisibilityChange = () => {
      if (!isDocumentVisible()) return;
      refreshFromVisibilitySignal();
    };

    window.addEventListener("focus", refreshFromVisibilitySignal);
    window.addEventListener("online", refreshFromVisibilitySignal);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("focus", refreshFromVisibilitySignal);
      window.removeEventListener("online", refreshFromVisibilitySignal);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkForJobChanges, isRefreshPaused]);

  // Lives here rather than on the Manage page because SwipePage calls this
  // hook too — a watcher mounted on one page would leave the other's batches
  // unwatched, and a swipe waiting on one would hang.
  useDetachedJobActionBatches();

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    // Through the shared stream: the run banner watches the same endpoint on
    // this page, and two independent subscriptions meant two sockets and two
    // server-side responses for one feed.
    const unsubscribe = subscribeToPipelineProgress({
      onConnectionChange: setIsPipelineSseConnected,
      onEvent: (payload: PipelineProgressEvent) => {
        const step = payload.step as unknown;
        if (typeof step !== "string") return;
        if (
          !ACTIVE_PIPELINE_STEPS.has(step as PipelineProgressStep) &&
          !TERMINAL_PIPELINE_STEPS.has(step as PipelineProgressStep) &&
          step !== "idle"
        ) {
          return;
        }

        const typedStep = step as PipelineProgressStep;
        const isActiveStep = ACTIVE_PIPELINE_STEPS.has(typedStep);

        // A multi-profile chain declares its own end: every event it emits
        // mid-chain is tagged with the profile it belongs to, and the one
        // untagged terminal at the end is the chain's. So a tagged event
        // never ends the run here — not the per-profile terminal, and not
        // the "idle" a profile sits in between reset and first crawl (which
        // is also what a re-subscribing client replays).
        const chainEvent =
          (payload as PipelineProgressEvent).profileRun != null;
        if (chainEvent && !isActiveStep) {
          observePipelineState({ isRunning: true, terminal: null });
          // Surface the finished profile's imports now rather than waiting
          // for the next profile's throttled refresh.
          if (TERMINAL_PIPELINE_STEPS.has(typedStep)) void loadJobs();
          return;
        }

        if (isActiveStep) {
          observePipelineState({ isRunning: true, terminal: null });
        } else if (typedStep === "idle") {
          observePipelineState({ isRunning: false, terminal: null });
        }

        if (isActiveStep) {
          const now = Date.now();
          if (now - lastSseRefreshAtRef.current >= 2500) {
            lastSseRefreshAtRef.current = now;
            void checkForJobChanges();
          }
          return;
        }

        if (TERMINAL_PIPELINE_STEPS.has(typedStep)) {
          const eventPayload = payload as PipelineProgressEvent;
          const terminal = typedStep as PipelineTerminalStatus;
          observePipelineState({
            isRunning: false,
            terminal: {
              status: terminal,
              errorMessage: eventPayload.error ?? null,
              signature: buildTerminalSignature({
                status: terminal,
                startedAt: eventPayload.startedAt,
                completedAt: eventPayload.completedAt,
              }),
            },
          });
          void loadJobs();
        }
      },
    });

    return () => {
      unsubscribe();
    };
  }, [checkForJobChanges, loadJobs, observePipelineState]);

  useEffect(() => {
    if (isPipelineSseConnected) return;

    const interval = setInterval(() => {
      if (!isDocumentVisible() || isRefreshPaused) return;
      void checkPipelineStatus();
    }, 30000);

    return () => clearInterval(interval);
  }, [checkPipelineStatus, isPipelineSseConnected, isRefreshPaused]);

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJob(null);
      return;
    }

    const selectedJobListItem = jobListItems.find(
      (job) => job.id === selectedJobId,
    );
    if (!selectedJobListItem) {
      setSelectedJob(null);
      return;
    }

    const cached = selectedJobCacheRef.current.get(selectedJobId);
    if (cached && cached.updatedAt === selectedJobListItem.updatedAt) {
      setSelectedJob(cached);
      return;
    }

    void loadSelectedJob(selectedJobId);
  }, [jobListItems, loadSelectedJob, selectedJobId]);

  return {
    jobs: jobListItems,
    selectedJob,
    stats,
    isLoading,
    isPipelineRunning,
    setIsPipelineRunning,
    pipelineTerminalEvent,
    isRefreshPaused,
    setIsRefreshPaused,
    loadJobs,
    checkForJobChanges,
    checkPipelineStatus,
  };
};
