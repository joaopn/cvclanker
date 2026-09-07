import { createJob } from "@shared/testing/factories";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getJobs = vi.fn();
vi.mock("@client/api", () => ({
  getJobs: (...args: unknown[]) => getJobs(...args),
}));

const warn = vi.fn();
vi.mock("@client/lib/toast", () => ({
  toast: { warning: (...a: unknown[]) => warn(...a) },
}));

// The real client carries a 30s global staleTime; a bare QueryClient here keeps
// the fetch behaviour of `fetchQuery` under test rather than the app's caching.
const fetchQuery = vi.fn();
vi.mock("@client/lib/queryClient", () => ({
  queryClient: { fetchQuery: (...args: unknown[]) => fetchQuery(...args) },
}));

import { queryKeys } from "@client/lib/queryKeys";
import { useTailorCompanyGuard } from "./useTailorCompanyGuard";

const candidate = (id: string, employer: string) => ({ id, employer });
const inFlight = (id: string, employer: string) =>
  createJob({ id, employer, status: "applied" });

beforeEach(() => {
  getJobs.mockReset();
  warn.mockReset();
  // Default: fetchQuery delegates to the mocked api, as react-query would.
  fetchQuery.mockReset();
  fetchQuery.mockImplementation(async (options: { queryFn: () => unknown }) =>
    options.queryFn(),
  );
});

describe("useTailorCompanyGuard", () => {
  it("asks the server nothing and approves everything while disabled", async () => {
    const { result } = renderHook(() => useTailorCompanyGuard(false));

    const approved = await result.current.confirmTailor([
      candidate("a", "Acme"),
    ]);

    expect(approved).toEqual(["a"]);
    expect(fetchQuery).not.toHaveBeenCalled();
    expect(result.current.prompt).toBeNull();
  });

  it("approves without prompting when nothing at those companies is in flight", async () => {
    getJobs.mockResolvedValue({ jobs: [inFlight("x", "Globex")] });
    const { result } = renderHook(() => useTailorCompanyGuard(true));

    const approved = await result.current.confirmTailor([
      candidate("a", "Acme"),
    ]);

    expect(approved).toEqual(["a"]);
    expect(fetchQuery).toHaveBeenCalledTimes(1);
    expect(result.current.prompt).toBeNull();
  });

  it("requests exactly the four in-flight statuses", async () => {
    getJobs.mockResolvedValue({ jobs: [] });
    const { result } = renderHook(() => useTailorCompanyGuard(true));

    await result.current.confirmTailor([candidate("a", "Acme")]);

    expect(getJobs).toHaveBeenCalledWith({
      statuses: ["processing", "ready", "applied", "in_progress"],
    });
  });

  it("reads fresh, under its own key", async () => {
    getJobs.mockResolvedValue({ jobs: [] });
    const { result } = renderHook(() => useTailorCompanyGuard(true));

    await result.current.confirmTailor([candidate("a", "Acme")]);

    // The app's client defaults to staleTime 30_000, so without the explicit 0
    // a press could decide against a list half a minute old — and the key must
    // not be the lazy-scoped list's, whose cache entry this would then poison.
    expect(fetchQuery.mock.calls[0][0]).toMatchObject({
      queryKey: queryKeys.jobs.inFlight(),
      staleTime: 0,
    });
  });

  it("opens a prompt and stays pending until the user answers", async () => {
    getJobs.mockResolvedValue({ jobs: [inFlight("x", "Acme")] });
    const { result } = renderHook(() => useTailorCompanyGuard(true));

    let settled: string[] | null | "pending" = "pending";
    result.current
      .confirmTailor([candidate("a", "Acme"), candidate("b", "Globex")])
      .then((ids) => {
        settled = ids;
      });

    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    expect(settled).toBe("pending");
    expect(result.current.prompt?.allIds).toEqual(["a", "b"]);
    expect(result.current.prompt?.safeIds).toEqual(["b"]);
    expect(result.current.prompt?.groups).toHaveLength(1);
    expect(result.current.prompt?.groups[0].employer).toBe("Acme");
  });

  it("resolves the chosen subset and closes the prompt", async () => {
    getJobs.mockResolvedValue({ jobs: [inFlight("x", "Acme")] });
    const { result } = renderHook(() => useTailorCompanyGuard(true));

    let settled: string[] | null | "pending" = "pending";
    result.current
      .confirmTailor([candidate("a", "Acme"), candidate("b", "Globex")])
      .then((ids) => {
        settled = ids;
      });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());

    await act(async () => {
      result.current.resolvePrompt(result.current.prompt?.safeIds ?? []);
    });

    expect(settled).toEqual(["b"]);
    expect(result.current.prompt).toBeNull();
  });

  it("resolves null when the user cancels", async () => {
    getJobs.mockResolvedValue({ jobs: [inFlight("x", "Acme")] });
    const { result } = renderHook(() => useTailorCompanyGuard(true));

    let settled: string[] | null | "pending" = "pending";
    result.current.confirmTailor([candidate("a", "Acme")]).then((ids) => {
      settled = ids;
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());

    await act(async () => {
      result.current.resolvePrompt(null);
    });

    expect(settled).toBeNull();
  });

  it("fails OPEN and warns when the check cannot be read", async () => {
    getJobs.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useTailorCompanyGuard(true));

    const approved = await result.current.confirmTailor([
      candidate("a", "Acme"),
    ]);

    expect(approved).toEqual(["a"]);
    expect(result.current.prompt).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("cancels an older pending press rather than stranding it", async () => {
    getJobs.mockResolvedValue({ jobs: [inFlight("x", "Acme")] });
    const { result } = renderHook(() => useTailorCompanyGuard(true));

    let first: string[] | null | "pending" = "pending";
    result.current.confirmTailor([candidate("a", "Acme")]).then((ids) => {
      first = ids;
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());

    await act(async () => {
      void result.current.confirmTailor([candidate("c", "Acme")]);
    });

    await waitFor(() => expect(first).toBeNull());
    await waitFor(() => expect(result.current.prompt?.allIds).toEqual(["c"]));
  });

  it("releases a press left pending when the page unmounts", async () => {
    getJobs.mockResolvedValue({ jobs: [inFlight("x", "Acme")] });
    const { result, unmount } = renderHook(() => useTailorCompanyGuard(true));

    let settled: string[] | null | "pending" = "pending";
    result.current.confirmTailor([candidate("a", "Acme")]).then((ids) => {
      settled = ids;
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());

    unmount();

    // Otherwise the caller awaits for ever and its spinner never clears.
    await waitFor(() => expect(settled).toBeNull());
  });

  it("releases a press left pending when the page unmounts MID-FETCH", async () => {
    // The window the plain cleanup cannot see: nothing is pending yet, so it
    // has nothing to release, and the promise created after the fetch settles
    // would install a resolver on a dead tree.
    let releaseFetch!: (value: { jobs: unknown[] }) => void;
    getJobs.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFetch = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useTailorCompanyGuard(true));

    let settled: string[] | null | "pending" = "pending";
    result.current.confirmTailor([candidate("a", "Acme")]).then((ids) => {
      settled = ids;
    });
    await waitFor(() => expect(getJobs).toHaveBeenCalled());

    unmount();
    releaseFetch({ jobs: [inFlight("x", "Acme")] });

    await waitFor(() => expect(settled).toBeNull());
  });

  it("re-reads the toggle without being rebuilt", async () => {
    getJobs.mockResolvedValue({ jobs: [inFlight("x", "Acme")] });
    const { result, rerender } = renderHook(
      ({ enabled }) => useTailorCompanyGuard(enabled),
      { initialProps: { enabled: false } },
    );
    const confirmTailor = result.current.confirmTailor;

    expect(await confirmTailor([candidate("a", "Acme")])).toEqual(["a"]);
    expect(fetchQuery).not.toHaveBeenCalled();

    rerender({ enabled: true });

    // The SAME captured callback must now check — a stale closure here means a
    // settings save does not take effect until something else re-renders.
    void confirmTailor([candidate("a", "Acme")]);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
  });
});
