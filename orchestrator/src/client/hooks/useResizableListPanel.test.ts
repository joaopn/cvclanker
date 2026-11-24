import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useResizablePanel } from "./useResizableListPanel";

const STORAGE_KEY = "test:panel:width";

const renderPanel = () =>
  renderHook(() =>
    useResizablePanel({
      storageKey: STORAGE_KEY,
      defaultWidth: 420,
      minWidth: 320,
      maxWidth: Number.POSITIVE_INFINITY,
      maxWidthShare: 0.7,
      invertDelta: true,
    }),
  );

describe("useResizablePanel", () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      value: 1000,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
    });
  });

  it("clamps a drag to the window share and stores the width", () => {
    const { result } = renderPanel();
    act(() => {
      result.current.startDrag({
        button: 0,
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.PointerEvent<HTMLElement>);
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 0 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
    expect(result.current.width).toBe(700);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("700");
  });

  it("starts from a stored width", () => {
    window.localStorage.setItem(STORAGE_KEY, "555");
    const { result } = renderPanel();
    expect(result.current.width).toBe(555);
  });

  it("renders with the default width when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const { result } = renderPanel();
    expect(result.current.width).toBe(420);
  });
});
