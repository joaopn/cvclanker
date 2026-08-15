import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useJobFilterChips } from "./useJobFilterChips";

const setup = () => {
  const clearFitFilter = vi.fn();
  const view = renderHook(() => useJobFilterChips({ clearFitFilter }));
  return { clearFitFilter, view };
};

describe("useJobFilterChips", () => {
  it("starts with the fit family on and nothing selected", () => {
    const { view } = setup();
    expect(view.result.current.enabledTypes).toEqual(["fit"]);
    expect(view.result.current.profileFilter).toEqual([]);
    expect(view.result.current.titleFilter).toEqual([]);
  });

  it("keeps the canonical row order however the tickboxes are clicked", () => {
    const { view } = setup();
    act(() => view.result.current.toggleType("title"));
    act(() => view.result.current.toggleType("profile"));
    expect(view.result.current.enabledTypes).toEqual([
      "fit",
      "profile",
      "title",
    ]);
  });

  it("toggles profile and title selections independently", () => {
    const { view } = setup();
    act(() => view.result.current.toggleProfileFilter("p1"));
    act(() => view.result.current.toggleProfileFilter("p2"));
    act(() => view.result.current.toggleTitleFilter("data engineer"));
    expect(view.result.current.profileFilter).toEqual(["p1", "p2"]);
    expect(view.result.current.titleFilter).toEqual(["data engineer"]);

    act(() => view.result.current.toggleProfileFilter("p1"));
    expect(view.result.current.profileFilter).toEqual(["p2"]);
  });

  it("clears a family's selection when its tickbox is switched off", () => {
    const { view } = setup();
    act(() => view.result.current.toggleType("profile"));
    act(() => view.result.current.toggleProfileFilter("p1"));
    act(() => view.result.current.toggleType("title"));
    act(() => view.result.current.toggleTitleFilter("data engineer"));

    act(() => view.result.current.toggleType("profile"));
    expect(view.result.current.enabledTypes).toEqual(["fit", "title"]);
    expect(view.result.current.profileFilter).toEqual([]);
    // The other family is untouched.
    expect(view.result.current.titleFilter).toEqual(["data engineer"]);
  });

  it("clears the URL-owned fit selection when the fit family is switched off", () => {
    const { view, clearFitFilter } = setup();
    act(() => view.result.current.toggleType("fit"));
    expect(view.result.current.enabledTypes).toEqual([]);
    expect(clearFitFilter).toHaveBeenCalledTimes(1);
  });

  it("clears the selection even when a family is toggled twice in one tick", () => {
    const { view } = setup();
    act(() => view.result.current.toggleType("profile"));
    act(() => view.result.current.toggleProfileFilter("p1"));

    // Both calls land before a re-render: the family must end up off AND its
    // selection cleared, not off-with-a-live-filter.
    act(() => {
      view.result.current.toggleType("profile");
      view.result.current.toggleType("profile");
      view.result.current.toggleType("profile");
    });

    expect(view.result.current.enabledTypes).toEqual(["fit"]);
    expect(view.result.current.profileFilter).toEqual([]);
  });

  it("clearSelections drops both selections but leaves the tickboxes alone", () => {
    const { view } = setup();
    act(() => view.result.current.toggleType("profile"));
    act(() => view.result.current.toggleProfileFilter("p1"));
    act(() => view.result.current.toggleTitleFilter("data engineer"));

    act(() => view.result.current.clearSelections());
    expect(view.result.current.profileFilter).toEqual([]);
    expect(view.result.current.titleFilter).toEqual([]);
    expect(view.result.current.enabledTypes).toEqual(["fit", "profile"]);
  });

  it("does not clear anything when a family is switched back on", () => {
    const { view, clearFitFilter } = setup();
    act(() => view.result.current.toggleType("fit"));
    clearFitFilter.mockClear();
    act(() => view.result.current.toggleType("fit"));
    expect(view.result.current.enabledTypes).toEqual(["fit"]);
    expect(clearFitFilter).not.toHaveBeenCalled();
  });
});
