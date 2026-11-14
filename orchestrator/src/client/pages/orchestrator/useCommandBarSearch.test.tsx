import { createJob } from "@shared/testing/factories";
import type { JobSearchResponse } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@client/api", () => ({
  searchJobs: vi.fn(),
}));

import * as api from "@client/api";
import { useCommandBarSearch } from "./useCommandBarSearch";

const deferred = () => {
  let resolve: (value: JobSearchResponse) => void = () => {};
  const promise = new Promise<JobSearchResponse>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// The app's client carries a 30s staleTime (lib/queryClient.ts); the same
// default here, so the hook's own staleTime is what the reopen test measures.
const renderSearch = (isOpen: boolean) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(({ open }) => useCommandBarSearch(open), {
    wrapper,
    initialProps: { open: isOpen },
  });
};

describe("useCommandBarSearch", () => {
  beforeEach(() => {
    vi.mocked(api.searchJobs).mockReset();
  });

  it("asks nothing while the dialog is closed", () => {
    renderSearch(false);

    expect(api.searchJobs).not.toHaveBeenCalled();
  });

  it("tags each answer with the search it answers, keeping the last one meanwhile", async () => {
    const first = createJob({ id: "first" });
    const second = createJob({ id: "second" });
    const pending = deferred();
    vi.mocked(api.searchJobs)
      .mockResolvedValueOnce({ jobs: [first], total: 1 })
      .mockReturnValueOnce(pending.promise);

    const { result } = renderSearch(true);
    await waitFor(() =>
      expect(result.current.results).toEqual({
        query: "",
        lock: null,
        jobs: [first],
        total: 1,
      }),
    );

    act(() => {
      result.current.onSearchChange({ query: "acme", lock: "ever_applied" });
    });

    expect(api.searchJobs).toHaveBeenLastCalledWith({
      query: "acme",
      lock: "ever_applied",
    });
    // Still the previous answer, still tagged as such.
    expect(result.current.results).toMatchObject({ query: "", lock: null });

    pending.resolve({ jobs: [second], total: 7 });
    await waitFor(() =>
      expect(result.current.results).toEqual({
        query: "acme",
        lock: "ever_applied",
        jobs: [second],
        total: 7,
      }),
    );
  });

  it("keeps the last answer and says the search failed when the next one errors", async () => {
    const first = createJob({ id: "first" });
    vi.mocked(api.searchJobs)
      .mockResolvedValueOnce({ jobs: [first], total: 1 })
      .mockRejectedValueOnce(new Error("boom"));

    const { result } = renderSearch(true);
    await waitFor(() => expect(result.current.results?.jobs).toEqual([first]));

    act(() => {
      result.current.onSearchChange({ query: "acme", lock: null });
    });
    await waitFor(() => expect(result.current.searchFailed).toBe(true));

    expect(result.current.results).toMatchObject({
      query: "",
      lock: null,
      jobs: [first],
    });
  });

  it("asks again when the dialog reopens, marking the cached answer pending", async () => {
    const first = createJob({ id: "first" });
    const pending = deferred();
    vi.mocked(api.searchJobs)
      .mockResolvedValueOnce({ jobs: [first], total: 1 })
      .mockReturnValueOnce(pending.promise);

    const { result, rerender } = renderSearch(true);
    await waitFor(() => expect(result.current.searchPending).toBe(false));
    expect(result.current.results?.jobs).toEqual([first]);

    rerender({ open: false });
    rerender({ open: true });

    await waitFor(() => expect(api.searchJobs).toHaveBeenCalledTimes(2));
    expect(result.current.searchPending).toBe(true);
    expect(result.current.results?.jobs).toEqual([first]);

    pending.resolve({ jobs: [], total: 0 });
    await waitFor(() => expect(result.current.searchPending).toBe(false));
    expect(result.current.results?.jobs).toEqual([]);
  });
});
