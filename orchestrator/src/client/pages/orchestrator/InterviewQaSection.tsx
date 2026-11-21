import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import type { Job } from "@shared/types";
import { Loader2, Pencil, RefreshCcw, Sparkles } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { JobDescriptionMarkdown } from "@/client/components/JobDescriptionMarkdown";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ReaderDialog, readerSubtitle } from "./ReaderDialog";

interface InterviewQaSectionProps {
  job: Job;
  onJobUpdated: () => Promise<void>;
}

const STEER_MAX = 2000;
const PREP_MAX = 20000;
const EMPTY_PREP_TEXT =
  "No interview strategy yet. Generate one to get a narrative, the questions you're likely to be asked, and high-leverage questions to ask back — grounded in your CV and this job.";

export const InterviewQaSection: React.FC<InterviewQaSectionProps> = ({
  job,
  onJobUpdated,
}) => {
  const prep = job.interviewPrep ?? "";
  const [steer, setSteer] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const handleGenerate = async () => {
    if (prep.trim().length > 0) {
      const ok = window.confirm(
        "Regenerate the interview strategy? This replaces the current one, including any manual edits.",
      );
      if (!ok) return;
    }
    try {
      setIsGenerating(true);
      await api.generateInterviewPrep(job.id, steer.trim());
      toast.success("Interview strategy generated");
      setIsEditing(false);
      await onJobUpdated();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to generate interview strategy",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const startEditing = () => {
    setDraft(prep);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setDraft("");
  };

  const handleSave = async () => {
    const next = draft.trim();
    if (next === prep.trim()) {
      setIsEditing(false);
      return;
    }
    try {
      setIsSaving(true);
      await api.updateJob(job.id, { interviewPrep: draft });
      toast.success("Interview strategy saved");
      setIsEditing(false);
      await onJobUpdated();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save changes",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const busy = isGenerating || isSaving;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Interview QA
        </div>
        <ReaderDialog title="Interview QA" subtitle={readerSubtitle(job)}>
          {prep.trim().length > 0 ? (
            <JobDescriptionMarkdown description={prep} />
          ) : (
            <p className="text-muted-foreground">{EMPTY_PREP_TEXT}</p>
          )}
        </ReaderDialog>
      </div>

      <div className="space-y-2 rounded-lg border border-border/60 bg-muted/10 p-3">
        <label
          htmlFor={`interview-steer-${job.id}`}
          className="text-[10px] uppercase tracking-wide text-muted-foreground/70"
        >
          Focus (optional)
        </label>
        <Textarea
          id={`interview-steer-${job.id}`}
          value={steer}
          maxLength={STEER_MAX}
          onChange={(event) => setSteer(event.target.value)}
          placeholder="Anything to focus on? e.g. a system-design panel, the interviewer is the CTO, address my Kubernetes gap…"
          className="min-h-[64px] text-sm leading-relaxed focus-visible:ring-1"
          disabled={busy}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={() => void handleGenerate()}
            disabled={busy}
          >
            {isGenerating ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : prep.trim().length > 0 ? (
              <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            )}
            {prep.trim().length > 0 ? "Regenerate" : "Generate strategy"}
          </Button>
        </div>
      </div>

      {isEditing ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            maxLength={PREP_MAX}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[280px] text-sm leading-relaxed focus-visible:ring-1"
            disabled={isSaving}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-3 text-xs"
              onClick={cancelEditing}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 px-3 text-xs"
              onClick={() => void handleSave()}
              disabled={isSaving}
            >
              {isSaving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Save
            </Button>
          </div>
        </div>
      ) : prep.trim().length > 0 ? (
        <div className="space-y-2">
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={startEditing}
              disabled={busy}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Button>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
            <JobDescriptionMarkdown description={prep} />
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground/70">{EMPTY_PREP_TEXT}</p>
      )}
    </div>
  );
};
