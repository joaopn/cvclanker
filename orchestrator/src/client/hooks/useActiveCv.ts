import { queryKeys } from "@/client/lib/queryKeys";
import type { CvDocument, CvDocumentSummary } from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import * as api from "../api";

/**
 * Returns the most recently updated CV document, or null when no CV has been
 * uploaded yet. Single-CV assumption — multi-CV management arrives later.
 */
export function useActiveCv() {
  const summariesQuery = useQuery<CvDocumentSummary[]>({
    queryKey: queryKeys.cvDocuments.list(),
    queryFn: api.listCvDocuments,
  });

  const activeId = summariesQuery.data?.[0]?.id ?? null;
  const detailQuery = useQuery<CvDocument>({
    queryKey: activeId
      ? queryKeys.cvDocuments.detail(activeId)
      : ["cv-documents", "detail", "none"],
    queryFn: () => {
      if (!activeId) {
        throw new Error("No active CV");
      }
      return api.getCvDocument(activeId);
    },
    enabled: Boolean(activeId),
  });

  const cv = detailQuery.data ?? null;
  const isLoading = summariesQuery.isLoading || detailQuery.isLoading;

  return {
    cv,
    isLoading,
    error: summariesQuery.error ?? detailQuery.error ?? null,
  };
}

/**
 * Just the active CV's NAME, without the detail fetch `useActiveCv` does — for
 * surfaces that only need to say which CV an action will run against. Gated by
 * `enabled` so a page that merely might show that copy does not pay for the
 * request until it actually can.
 */
export function useActiveCvName(enabled: boolean): string | null {
  const summariesQuery = useQuery<CvDocumentSummary[]>({
    queryKey: queryKeys.cvDocuments.list(),
    queryFn: api.listCvDocuments,
    enabled,
  });
  return summariesQuery.data?.[0]?.name?.trim() || null;
}
