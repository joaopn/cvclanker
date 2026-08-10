import type { JobStatus } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory (also hoisted) can reference the same fns
// without a TDZ error.
const api = vi.hoisted(() => ({
  getJobs: vi.fn(),
  getPipelineStatus: vi.fn(),
  getJobsRevision: vi.fn(),
  getJob: vi.fn(),
}));

vi.mock("@client/api", () => api);
vi.mock("@client/lib/sse", () => ({
  subscribeToEventSource: vi.fn(() => () => {}),
}));

import { useOrchestratorData } from "./useOrchestratorData";

const emptyByStatus: Record<JobStatus, number> = {
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

beforeEach(() => {
  // The hook skips its progress subscription entirely when EventSource is
  // absent, which it is in jsdom. Only its presence matters — the transport
  // itself is mocked above.
  vi.stubGlobal("EventSource", class {});
  api.getJobs.mockResolvedValue({
    jobs: [],
    byStatus: emptyByStatus,
    revision: "r1",
  });
  api.getPipelineStatus.mockResolvedValue({ isRunning: false, lastRun: null });
  api.getJobsRevision.mockResolvedValue({ revision: "r1" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const makeWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

/**
 * Drive the pipeline-progress SSE stream by hand: grab the `onMessage` the hook
 * registered and feed it events.
 */
async function progressEmitter() {
  const { subscribeToEventSource } = await import("@client/lib/sse");
  const call = vi
    .mocked(subscribeToEventSource)
    .mock.calls.find(([url]) => url === "/api/pipeline/progress");
  const onMessage = call?.[1]?.onMessage;
  if (!onMessage) throw new Error("progress stream was never subscribed");
  return (event: Record<string, unknown>) => {
    act(() => {
      onMessage(event as never);
    });
  };
}

const chainEvent = (step: string, index: number, extra = {}) => ({
  step,
  startedAt: `2026-01-0${index}T00:00:00.000Z`,
  completedAt: `2026-01-0${index}T01:00:00.000Z`,
  profileRun: { id: `p${index}`, name: `Profile ${index}`, index, total: 2 },
  ...extra,
});

describe("useOrchestratorData multi-profile runs", () => {
  it("keeps the run alive across a profile's own terminal and idle", async () => {
    const { result } = renderHook(() => useOrchestratorData(null), {
      wrapper: makeWrapper(),
    });
    const emit = await progressEmitter();

    emit(chainEvent("crawling", 1));
    await waitFor(() => expect(result.current.isPipelineRunning).toBe(true));

    // Profile 1 finishes, and profile 2 sits at "idle" between its reset and
    // first crawl. Neither ends the chain, and neither toasts.
    emit(chainEvent("completed", 1));
    expect(result.current.isPipelineRunning).toBe(true);
    expect(result.current.pipelineTerminalEvent).toBeNull();

    emit(chainEvent("idle", 2));
    expect(result.current.isPipelineRunning).toBe(true);
    expect(result.current.pipelineTerminalEvent).toBeNull();

    // The chain's own terminal arrives untagged — that one ends the run.
    emit({
      step: "completed",
      startedAt: "2026-01-09T00:00:00.000Z",
      completedAt: "2026-01-09T01:00:00.000Z",
      profileRun: null,
    });
    await waitFor(() =>
      expect(result.current.pipelineTerminalEvent?.status).toBe("completed"),
    );
    expect(result.current.isPipelineRunning).toBe(false);
  });

  it("still ends a single (untagged) run on its own terminal", async () => {
    const { result } = renderHook(() => useOrchestratorData(null), {
      wrapper: makeWrapper(),
    });
    const emit = await progressEmitter();

    emit({ step: "crawling", startedAt: "2026-02-01T00:00:00.000Z" });
    await waitFor(() => expect(result.current.isPipelineRunning).toBe(true));

    emit({
      step: "failed",
      startedAt: "2026-02-01T00:00:00.000Z",
      completedAt: "2026-02-01T01:00:00.000Z",
      error: "boom",
    });

    await waitFor(() =>
      expect(result.current.pipelineTerminalEvent?.status).toBe("failed"),
    );
    expect(result.current.pipelineTerminalEvent?.errorMessage).toBe("boom");
  });
});

describe("useOrchestratorData full-view switching", () => {
  it("fetches the list view by default and the full view once needsFullView flips", async () => {
    const { rerender } = renderHook(
      ({ full }: { full: boolean }) => useOrchestratorData(null, full),
      { initialProps: { full: false }, wrapper: makeWrapper() },
    );

    await waitFor(() =>
      expect(api.getJobs).toHaveBeenCalledWith({ view: "list" }),
    );
    expect(api.getJobs).not.toHaveBeenCalledWith({ view: "full" });

    api.getJobs.mockClear();
    rerender({ full: true });

    await waitFor(() =>
      expect(api.getJobs).toHaveBeenCalledWith({ view: "full" }),
    );
  });
});
