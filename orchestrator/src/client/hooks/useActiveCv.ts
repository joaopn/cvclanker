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
  const personName = readPersonName(cv) || "Resume";
  const isLoading = summariesQuery.isLoading || detailQuery.isLoading;

  return {
    cv,
    personName,
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

function readPersonName(cv: CvDocument | null): string {
  if (!cv) return "";
  // Pick the first field whose role is "name" — by convention the
  // candidate's display name. Falls back to empty if no such field exists
  // (extraction failure or pre-5d document).
  const nameField = cv.fields.find((field) => field.role === "name");
  return nameField?.value.trim() ?? "";
}
