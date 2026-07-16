import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const CLICK_DRAG_THRESHOLD_PX = 3;

export const LIST_PANEL_STORAGE_WIDTH_KEY = "cvclanker:listPanel:width";
export const LIST_PANEL_STORAGE_VISIBLE_KEY = "cvclanker:listPanel:visible";
export const LIST_PANEL_MIN_WIDTH = 280;
export const LIST_PANEL_MAX_WIDTH = 720;
export const LIST_PANEL_DEFAULT_WIDTH = 400;

interface UseResizablePanelOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /**
   * When true, dragging right *shrinks* the persisted column. Use for a
   * right-anchored panel where the persisted dimension is the right column's
   * width and the divider sits to the left of it.
   */
  invertDelta?: boolean;
}

interface UseResizablePanelResult {
  width: number;
  isDragging: boolean;
  startDrag: (event: React.PointerEvent<HTMLElement>) => void;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function readInitialWidth(
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
): number {
  if (typeof window === "undefined") return defaultWidth;
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return defaultWidth;
  return clamp(Number.parseInt(raw, 10), minWidth, maxWidth, defaultWidth);
}

export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  invertDelta = false,
}: UseResizablePanelOptions): UseResizablePanelResult {
  const [width, setWidth] = useState<number>(() =>
    readInitialWidth(storageKey, defaultWidth, minWidth, maxWidth),
  );
  const [isDragging, setIsDragging] = useState(false);
  const widthRef = useRef(width);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      let moved = false;

      const handleMove = (e: PointerEvent) => {
        const rawDelta = e.clientX - startX;
        if (!moved) {
          if (Math.abs(rawDelta) < CLICK_DRAG_THRESHOLD_PX) return;
          moved = true;
          setIsDragging(true);
          document.body.style.userSelect = "none";
          document.body.style.cursor = "col-resize";
        }
        const delta = invertDelta ? -rawDelta : rawDelta;
        setWidth(clamp(startWidth + delta, minWidth, maxWidth, defaultWidth));
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (moved) setIsDragging(false);
      };

      const handleUp = () => {
        cleanup();
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [defaultWidth, invertDelta, maxWidth, minWidth],
  );

  return { width, isDragging, startDrag };
}

interface UseResizableListPanelResult extends UseResizablePanelResult {
  isVisible: boolean;
  toggleVisible: () => void;
  setVisible: (visible: boolean) => void;
}

function readInitialVisible(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(LIST_PANEL_STORAGE_VISIBLE_KEY) !== "false";
}

export function useResizableListPanel(): UseResizableListPanelResult {
  const panel = useResizablePanel({
    storageKey: LIST_PANEL_STORAGE_WIDTH_KEY,
    defaultWidth: LIST_PANEL_DEFAULT_WIDTH,
    minWidth: LIST_PANEL_MIN_WIDTH,
    maxWidth: LIST_PANEL_MAX_WIDTH,
  });
  const [isVisible, setIsVisible] = useState<boolean>(readInitialVisible);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      LIST_PANEL_STORAGE_VISIBLE_KEY,
      String(isVisible),
    );
  }, [isVisible]);

  const toggleVisible = useCallback(() => {
    setIsVisible((prev) => !prev);
  }, []);

  const setVisible = useCallback((value: boolean) => {
    setIsVisible(value);
  }, []);

  return {
    ...panel,
    isVisible,
    toggleVisible,
    setVisible,
  };
}
