import { useEffect, useState } from "react";

export const TOP_BAR_STORAGE_VISIBLE_KEY = "cvclanker:topBar:visible";

function readInitialVisible(): boolean {
  try {
    return window.localStorage.getItem(TOP_BAR_STORAGE_VISIBLE_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * Whether the shared page header is shown. Persisted in this browser, so the
 * choice carries across pages and reloads.
 */
export function useTopBarVisibility() {
  const [isVisible, setIsVisible] = useState<boolean>(readInitialVisible);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        TOP_BAR_STORAGE_VISIBLE_KEY,
        String(isVisible),
      );
    } catch {
      // Storage unavailable (site data blocked, quota): the choice lasts
      // until the next page mount instead.
    }
  }, [isVisible]);

  return { isVisible, setVisible: setIsVisible };
}
