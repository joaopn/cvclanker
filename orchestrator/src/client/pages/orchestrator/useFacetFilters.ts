import { useCallback, useMemo, useState } from "react";
import {
  type ActiveFacet,
  FACET_DEFS_BY_ID,
  facetRequiresFullView,
} from "./facets/registry";

export interface UseFacetFilters {
  activeFacets: ActiveFacet[];
  requiresFullView: boolean;
  addFacet: (id: string) => void;
  removeFacet: (id: string) => void;
  setFacetValue: (id: string, value: string) => void;
  clearFacets: () => void;
}

// Ephemeral (in-memory, non-URL) faceted filters for the Manage view. Kept out
// of useOrchestratorFilters deliberately: facet state must not persist to the
// URL or survive a reload, and this separation is what keeps it from becoming a
// hidden-active filter across tabs.
export function useFacetFilters(): UseFacetFilters {
  const [activeFacets, setActiveFacets] = useState<ActiveFacet[]>([]);

  const addFacet = useCallback((id: string) => {
    setActiveFacets((prev) => {
      if (!FACET_DEFS_BY_ID[id] || prev.some((facet) => facet.id === id)) {
        return prev;
      }
      return [...prev, { id, value: "" }];
    });
  }, []);

  const removeFacet = useCallback((id: string) => {
    setActiveFacets((prev) => prev.filter((facet) => facet.id !== id));
  }, []);

  const setFacetValue = useCallback((id: string, value: string) => {
    setActiveFacets((prev) =>
      prev.map((facet) => (facet.id === id ? { ...facet, value } : facet)),
    );
  }, []);

  const clearFacets = useCallback(() => setActiveFacets([]), []);

  const requiresFullView = useMemo(
    () => facetRequiresFullView(activeFacets),
    [activeFacets],
  );

  return {
    activeFacets,
    requiresFullView,
    addFacet,
    removeFacet,
    setFacetValue,
    clearFacets,
  };
}
