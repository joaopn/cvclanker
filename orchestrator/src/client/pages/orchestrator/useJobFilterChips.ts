import { useCallback, useRef, useState } from "react";
import {
  DEFAULT_JOB_FILTER_CHIP_TYPES,
  JOB_FILTER_CHIP_TYPES,
  type JobFilterChipType,
} from "./constants";

export interface UseJobFilterChips {
  enabledTypes: JobFilterChipType[];
  profileFilter: string[];
  titleFilter: string[];
  toggleType: (type: JobFilterChipType) => void;
  toggleProfileFilter: (profileId: string) => void;
  toggleTitleFilter: (title: string) => void;
  /** Drops every badge selection, leaving the tickboxes as they are. */
  clearSelections: () => void;
}

/**
 * Owns which badge-filter families the Manage view shows, plus the profile and
 * job-title selections. Ephemeral (in-memory, non-URL) for the same reason the
 * facets are: these narrow the list from a set of options that is itself
 * derived from the current Search Profiles, so persisting them would resurrect
 * stale ids after a profile is renamed or deleted.
 *
 * The fit selection is NOT owned here — it stays in the URL (`?fit=`), where it
 * already was. Switching a family off clears that family's selection, which is
 * what keeps a hidden row from leaving an invisible filter applied; for fit
 * that means calling back into the URL owner.
 */
export function useJobFilterChips(options: {
  clearFitFilter: () => void;
}): UseJobFilterChips {
  const { clearFitFilter } = options;
  const [enabledTypes, setEnabledTypes] = useState<JobFilterChipType[]>(() => [
    ...DEFAULT_JOB_FILTER_CHIP_TYPES,
  ]);
  const [profileFilter, setProfileFilter] = useState<string[]>([]);
  const [titleFilter, setTitleFilter] = useState<string[]>([]);

  // One source of truth for both the next value and the clear-on-disable side
  // effect. Reading state through the ref rather than the render closure keeps
  // two toggles in a single tick consistent: deciding from `prev` inside the
  // updater while deciding the side effect from the closure would let the
  // second toggle switch a family off without clearing its selection, leaving
  // it narrowing the list with its row hidden.
  const enabledTypesRef = useRef(enabledTypes);
  const toggleType = useCallback(
    (type: JobFilterChipType) => {
      const previous = enabledTypesRef.current;
      const wasEnabled = previous.includes(type);
      const next = wasEnabled
        ? previous.filter((entry) => entry !== type)
        : // Rebuild from the canonical list so the rows keep a fixed order
          // however the tickboxes were clicked.
          JOB_FILTER_CHIP_TYPES.filter(
            (entry) => entry === type || previous.includes(entry),
          );
      enabledTypesRef.current = next;
      setEnabledTypes(next);
      if (!wasEnabled) return;
      if (type === "fit") clearFitFilter();
      else if (type === "profile") setProfileFilter([]);
      else setTitleFilter([]);
    },
    [clearFitFilter],
  );

  const toggleProfileFilter = useCallback((profileId: string) => {
    setProfileFilter((prev) =>
      prev.includes(profileId)
        ? prev.filter((entry) => entry !== profileId)
        : [...prev, profileId],
    );
  }, []);

  const toggleTitleFilter = useCallback((title: string) => {
    setTitleFilter((prev) =>
      prev.includes(title)
        ? prev.filter((entry) => entry !== title)
        : [...prev, title],
    );
  }, []);

  const clearSelections = useCallback(() => {
    setProfileFilter([]);
    setTitleFilter([]);
  }, []);

  return {
    enabledTypes,
    profileFilter,
    titleFilter,
    toggleType,
    toggleProfileFilter,
    toggleTitleFilter,
    clearSelections,
  };
}
