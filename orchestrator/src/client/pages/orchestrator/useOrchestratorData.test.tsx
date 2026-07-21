import type { JobStatus } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
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
});

const makeWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

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
