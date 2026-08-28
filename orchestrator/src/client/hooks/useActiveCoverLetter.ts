import { queryKeys } from "@/client/lib/queryKeys";
import type {
  CoverLetterDocument,
  CoverLetterDocumentSummary,
} from "@shared/types";
import { useQuery } from "@tanstack/react-query";
import * as api from "../api";

/**
 * Returns the most recently updated cover-letter document, or null when
 * none has been uploaded yet. Single-doc assumption — multi-cover-letter
 * arrives in phase 8b.
 */
export function useActiveCoverLetter() {
  const summariesQuery = useQuery<CoverLetterDocumentSummary[]>({
    queryKey: queryKeys.coverLetterDocuments.list(),
    queryFn: api.listCoverLetters,
  });

  const activeId = summariesQuery.data?.[0]?.id ?? null;
  const detailQuery = useQuery<CoverLetterDocument>({
    queryKey: activeId
      ? queryKeys.coverLetterDocuments.detail(activeId)
      : ["cover-letter-documents", "detail", "none"],
    queryFn: () => {
      if (!activeId) {
        throw new Error("No active cover letter");
      }
      return api.getCoverLetter(activeId);
    },
    enabled: Boolean(activeId),
  });

  const coverLetter = detailQuery.data ?? null;
  const bodyField = coverLetter
    ? (coverLetter.fields.find((field) => field.role === "body") ?? null)
    : null;

  return {
    coverLetter,
    bodyFieldId: bodyField?.id ?? null,
    isLoading: summariesQuery.isLoading || detailQuery.isLoading,
    error: summariesQuery.error ?? detailQuery.error ?? null,
  };
}
