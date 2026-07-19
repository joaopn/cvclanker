import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Mail, RefreshCcw, Save } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "@client/lib/toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type BriefPaneProps = {
  jobId: string;
  cvId: string | null;
  brief: string;
  onJobUpdated?: () => void | Promise<void>;
};

/**
 * Full-height personal-brief editor used as a top-level tab in the Ready
 * panel. The brief lives on the active CV document (shared across jobs);
 * "Re-tailor with brief" re-runs tailoring for this job against the saved
 * brief.
 */
export const BriefPane: React.FC<BriefPaneProps> = ({
  jobId,
  cvId,
  brief,
  onJobUpdated,
}) => {
  const [draft, setDraft] = useState(brief);
  const [isReTailoring, setIsReTailoring] = useState(false);
  const queryClient = useQueryClient();

  // Re-sync the textarea when the upstream brief changes (e.g. an accepted
  // brief-edit applied via the chat panel). Drop in-flight local edits — the
  // user's typed text is unsaved scratch.
  useEffect(() => {
    setDraft(brief);
  }, [brief]);

  const saveMutation = useMutation({
    mutationFn: async (next: string) => {
      if (!cvId) throw new Error("No active CV to save brief on");
      return api.updateCvDocument(cvId, { personalBrief: next });
    },
    onSuccess: (cv) => {
      if (cv?.id) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.cvDocuments.detail(cv.id),
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.cvDocuments.list(),
      });
      toast.success("Brief saved");
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : "Failed to save brief";
      toast.error(message);
    },
  });

  const reTailor = useCallback(async () => {
    setIsReTailoring(true);
    try {
      await api.reTailorJob(jobId);
      toast.success("Re-tailored against current brief");
      await onJobUpdated?.();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Re-tailor failed";
      toast.error(message);
    } finally {
      setIsReTailoring(false);
    }
  }, [jobId, onJobUpdated]);

  const isDirty = draft !== brief;
  const canSave = isDirty && !saveMutation.isPending && Boolean(cvId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Personal brief</span>
          <span className="text-xs text-muted-foreground">
            ({brief.length} chars)
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={reTailor}
            disabled={isReTailoring || !cvId}
          >
            {isReTailoring ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            Re-tailor with brief
          </Button>
          <Button
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={!canSave}
            onClick={() => saveMutation.mutate(draft)}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save brief
          </Button>
        </div>
      </div>

      {!cvId ? (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-status-warn/30 bg-status-warn/10 px-2 py-1.5 text-xs text-status-warn-text">
          <Mail className="h-3.5 w-3.5" />
          No active CV — upload a CV from the CV page to save a brief.
        </div>
      ) : null}

      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Paste a free-form summary of your background — projects, side gigs, soft skills, anything the CV doesn't capture verbatim."
        className="h-full min-h-[320px] flex-1 resize-none text-sm"
      />
    </div>
  );
};
