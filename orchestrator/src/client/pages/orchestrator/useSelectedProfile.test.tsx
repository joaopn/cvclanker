import { defaultProfileConfig, type Profile } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getProfiles: vi.fn(),
  setDefaultProfile: vi.fn(),
}));

vi.mock("@client/api", () => api);

import { useSelectedProfile } from "./useSelectedProfile";

const makeProfile = (id: string, name: string): Profile => ({
  id,
  name,
  config: defaultProfileConfig(),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

// getProfiles is ordered updated_at DESC, so "newest first".
const PROFILES = [
  makeProfile("a", "Newest"),
  makeProfile("b", "Default one"),
  makeProfile("c", "Oldest"),
];

beforeEach(() => {
  api.getProfiles.mockResolvedValue({
    profiles: PROFILES,
    defaultProfileId: "b",
  });
  api.setDefaultProfile.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// One client per mount, held outside the wrapper: rebuilding it inside the
// JSX would hand every re-render an empty cache, so `rerender()` would
// remount against no data instead of exercising a real re-render.
const makeWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
};

async function mounted() {
  const view = renderHook(() => useSelectedProfile(), {
    wrapper: makeWrapper(),
  });
  await waitFor(() =>
    expect(view.result.current.selectedProfileIds).toEqual(["b"]),
  );
  return view;
}

describe("useSelectedProfile", () => {
  it("starts with the server default as the only selection", async () => {
    const { result } = await mounted();
    expect(result.current.selectedProfileId).toBe("b");
    expect(api.setDefaultProfile).not.toHaveBeenCalled();
  });

  it("keeps the selection in dropdown order, not click order", async () => {
    const { result } = await mounted();

    act(() => result.current.toggleProfile("c"));
    act(() => result.current.toggleProfile("a"));

    expect(result.current.selectedProfileIds).toEqual(["a", "b", "c"]);
  });

  it("does NOT repoint the persisted default when adding a profile", async () => {
    const { result } = await mounted();

    // "a" sorts ahead of the default "b", so a naive "persist the head" rule
    // would silently make every later profile-less run use "a".
    act(() => result.current.toggleProfile("a"));

    expect(result.current.selectedProfileIds).toEqual(["a", "b"]);
    // Flush the microtask `mutate` would have deferred into, so this assertion
    // can't pass merely by outrunning it.
    await act(async () => {});
    expect(api.setDefaultProfile).not.toHaveBeenCalled();
  });

  it("persists the default once the selection narrows back to one", async () => {
    const { result } = await mounted();

    act(() => result.current.toggleProfile("a"));
    act(() => result.current.toggleProfile("b"));

    expect(result.current.selectedProfileIds).toEqual(["a"]);
    // `mutate` defers the mutation fn to a microtask.
    await waitFor(() =>
      expect(api.setDefaultProfile).toHaveBeenCalledWith("a"),
    );
  });

  it("refuses to untick the last selected profile", async () => {
    const { result } = await mounted();

    act(() => result.current.toggleProfile("b"));

    expect(result.current.selectedProfileIds).toEqual(["b"]);
    await act(async () => {});
    expect(api.setDefaultProfile).not.toHaveBeenCalled();
  });

  it("keeps a stable array identity while the dropdown is untouched", async () => {
    const { result, rerender } = await mounted();
    const first = result.current.selectedProfileIds;

    rerender();

    // Consumers list this in memo dep arrays; a fresh array each render would
    // silently disable them.
    expect(result.current.selectedProfileIds).toBe(first);
  });
});
