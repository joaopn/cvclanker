import * as api from "@client/api";
import {
  DiscoveredPanel,
  FitAssessment,
  FitIndicator,
} from "@client/components";
import { JobDetailsEditDrawer } from "@client/components/JobDetailsEditDrawer";
import { ReadyPanel } from "@client/components/ReadyPanel";
import {
  useMarkAsAppliedMutation,
  useSkipJobMutation,
} from "@client/hooks/queries/useJobMutations";
import { useActiveCv } from "@client/hooks/useActiveCv";
import { useSettings } from "@client/hooks/useSettings";
import { toast } from "@client/lib/toast";
import { restoreJobStates, snapshotJob } from "@client/lib/undo";
import type { Job, JobListItem, JobOutcome } from "@shared/types.js";
import {
  CheckCircle2,
  Copy,
  Edit2,
  ExternalLink,
  FileText,
  Loader2,
  MoreHorizontal,
  RefreshCcw,
  Save,
  XCircle,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JobDescriptionMarkdown } from "@/client/components/JobDescriptionMarkdown";
import { getRenderableJobDescription } from "@/client/lib/jobDescription";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  copyTextToClipboard,
  formatJobForWebhook,
  safeFilenamePart,
} from "@/lib/utils";
import { CompanyNameButton } from "./CompanyNameButton";
import { type FilterTab, outcomeLabel } from "./constants";
import { InterviewQaSection } from "./InterviewQaSection";
import { JobDocumentsPanel } from "./JobDocumentsPanel";
import { JobNotesSection } from "./JobNotesSection";
import { JobStageSwitcher } from "./JobStageSwitcher";
import { MarkClosedPopover } from "./MarkClosedPopover";
import { useUndo } from "./useUndoController";

interface JobDetailPanelProps {
  activeTab: FilterTab;
  activeJobs: JobListItem[];
  selectedJob: Job | null;
  onSelectJobId: (jobId: string | null) => void;
  onJobUpdated: () => Promise<void>;
  onPauseRefreshChange?: (paused: boolean) => void;
}

export const JobDetailPanel: React.FC<JobDetailPanelProps> = ({
  activeTab,
  activeJobs,
  selectedJob,
  onSelectJobId,
  onJobUpdated,
  onPauseRefreshChange,
}) => {
  const [detailTab, setDetailTab] = useState<
    "overview" | "description" | "notes" | "documents" | "interview"
  >("overview");
  const [isEditingDescription, setIsEditingDescription] = useState(false);
  const [editedDescription, setEditedDescription] = useState("");
  const [isSavingDescription, setIsSavingDescription] = useState(false);
  const [processingJobId, setProcessingJobId] = useState<string | null>(null);
  const [isEditDetailsOpen, setIsEditDetailsOpen] = useState(false);
  const previousSelectedJobIdRef = useRef<string | null>(null);
  const markAsAppliedMutation = useMarkAsAppliedMutation();
  const skipJobMutation = useSkipJobMutation();

  const { pushUndo, undo } = useUndo();
  const registerUndo = useCallback(
    (job: Job, label: string) => {
      const snap = snapshotJob(job);
      pushUndo({
        label,
        restore: async () => {
          await restoreJobStates([snap]);
        },
      });
    },
    [pushUndo],
  );
  const undoToastAction = useMemo(
    () => ({ label: "Undo", onClick: () => undo() }),
    [undo],
  );

  const { personName } = useActiveCv();
  const { cvSourceFormat, renderMarkdownInJobDescriptions } = useSettings();
  const openEditDetails = useCallback(() => {
    window.setTimeout(() => setIsEditDetailsOpen(true), 0);
  }, []);

  const handleTailoringDirtyChange = useCallback(
    (isDirty: boolean) => {
      onPauseRefreshChange?.(isDirty);
    },
    [onPauseRefreshChange],
  );

  useEffect(() => {
    const currentJobId = selectedJob?.id ?? null;
    if (previousSelectedJobIdRef.current === currentJobId) return;
    previousSelectedJobIdRef.current = currentJobId;
    onPauseRefreshChange?.(false);
  }, [selectedJob?.id, onPauseRefreshChange]);

  useEffect(() => {
    return () => onPauseRefreshChange?.(false);
  }, [onPauseRefreshChange]);

  const description = useMemo(() => {
    return getRenderableJobDescription(selectedJob?.jobDescription);
  }, [selectedJob]);

  useEffect(() => {
    if (!selectedJob) {
      setIsEditingDescription(false);
      setEditedDescription("");
      setIsEditDetailsOpen(false);
      return;
    }
    setIsEditingDescription(false);
    setEditedDescription(selectedJob.jobDescription || "");
    setIsEditDetailsOpen(false);
    const jobIsLive =
      selectedJob.status === "applied" || selectedJob.status === "in_progress";
    const jobHasDocuments =
      !!selectedJob.pdfPath || !!selectedJob.coverLetterPdfPath;
    setDetailTab(jobIsLive && jobHasDocuments ? "documents" : "overview");
  }, [selectedJob?.id, selectedJob]);

  useEffect(() => {
    if (!selectedJob) return;
    if (!isEditingDescription) {
      setEditedDescription(selectedJob.jobDescription || "");
    }
  }, [selectedJob?.jobDescription, isEditingDescription, selectedJob]);

  const handleSaveDescription = async () => {
    if (!selectedJob) return;
    try {
      setIsSavingDescription(true);
      await api.updateJob(selectedJob.id, {
        jobDescription: editedDescription,
      });
      toast.success("Job description updated");
      setIsEditingDescription(false);
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update description";
      toast.error(message);
    } finally {
      setIsSavingDescription(false);
    }
  };

  const hasUnsavedDescription =
    !!selectedJob &&
    isEditingDescription &&
    editedDescription !== (selectedJob.jobDescription || "");

  const confirmAndSaveEdits = useCallback(async () => {
    if (!hasUnsavedDescription) return true;

    const message =
      "You have unsaved job description edits. Save before generating the PDF?";
    if (!window.confirm(message)) return false;

    try {
      if (selectedJob) {
        await api.updateJob(selectedJob.id, {
          jobDescription: editedDescription,
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to save changes";
      toast.error(errorMessage);
      return false;
    }

    return true;
  }, [editedDescription, hasUnsavedDescription, selectedJob]);

  const handleProcess = async () => {
    if (!selectedJob) return;
    try {
      const shouldProceed = await confirmAndSaveEdits();
      if (!shouldProceed) return;

      setProcessingJobId(selectedJob.id);

      if (selectedJob.status === "ready") {
        await api.generateJobPdf(selectedJob.id);
        toast.success("Resume regenerated successfully");
      } else {
        await api.processJob(selectedJob.id);
        toast.success("Tailoring started", {
          description: "It'll appear in the Tailoring tab when ready.",
        });
      }
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to process job";
      toast.error(message);
    } finally {
      setProcessingJobId(null);
    }
  };

  const handleApply = async () => {
    if (!selectedJob) return;
    try {
      await markAsAppliedMutation.mutateAsync(selectedJob.id);
      registerUndo(selectedJob, "Mark applied");
      toast.success("Marked as applied", { action: undoToastAction });
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to mark as applied";
      toast.error(message);
    }
  };

  const handleSkip = async () => {
    if (!selectedJob) return;
    try {
      await skipJobMutation.mutateAsync(selectedJob.id);
      registerUndo(selectedJob, "Skip");
      toast.message("Job skipped", { action: undoToastAction });
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to skip job";
      toast.error(message);
    }
  };

  const handleMoveToInProgress = async () => {
    if (!selectedJob) return;
    try {
      await api.updateJob(selectedJob.id, { status: "in_progress" });
      registerUndo(selectedJob, "Move to Interviewing");
      toast.success("Moved to Interviewing", { action: undoToastAction });
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to move to Interviewing";
      toast.error(message);
    }
  };

  const handleMarkClosed = async (outcome: JobOutcome) => {
    if (!selectedJob) return;
    try {
      await api.updateJobOutcome(selectedJob.id, { outcome });
      await api.updateJob(selectedJob.id, { status: "closed" });
      registerUndo(selectedJob, "Close application");
      toast.success("Application closed", { action: undoToastAction });
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to close application";
      toast.error(message);
    }
  };

  const handleTailorRow = async () => {
    if (!selectedJob) return;
    try {
      // Tailoring runs in the background; the row flips to processing and
      // appears in the Tailoring tab. Not undoable (creates a PDF).
      await api.processJob(selectedJob.id);
      toast.message("Tailoring started");
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start tailoring";
      toast.error(message);
    }
  };

  const handleReopen = async () => {
    if (!selectedJob) return;
    try {
      await api.updateJob(selectedJob.id, {
        status: "discovered",
        outcome: null,
        closedAt: null,
      });
      registerUndo(selectedJob, "Reopen");
      toast.success("Job reopened", { action: undoToastAction });
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to reopen job";
      toast.error(message);
    }
  };

  const handleCopyInfo = async () => {
    if (!selectedJob) return;
    try {
      await copyTextToClipboard(formatJobForWebhook(selectedJob));
      toast.success("Copied job info", {
        description: "Webhook payload copied to clipboard.",
      });
    } catch {
      toast.error("Could not copy job info");
    }
  };

  const handleJobMoved = useCallback(
    (jobId: string) => {
      const currentIndex = activeJobs.findIndex((job) => job.id === jobId);
      const nextJob =
        activeJobs[currentIndex + 1] || activeJobs[currentIndex - 1];
      onSelectJobId(nextJob?.id ?? null);
    },
    [activeJobs, onSelectJobId],
  );

  const selectedHasPdf = !!selectedJob?.pdfPath;
  const selectedHasCover = !!selectedJob?.coverLetterPdfPath;
  const selectedJobLink = selectedJob
    ? selectedJob.applicationLink || selectedJob.jobUrl
    : "#";
  const selectedPdfHref = selectedJob
    ? `/pdfs/resume_${selectedJob.id}.pdf?v=${encodeURIComponent(selectedJob.updatedAt)}`
    : "#";
  const selectedCoverHref = selectedJob
    ? `/pdfs/cover_letter_${selectedJob.id}.pdf?v=${encodeURIComponent(selectedJob.updatedAt)}`
    : "#";

  // Download hands over the editable artifact — the .docx on a Word profile.
  // selectedPdfHref stays the PDF: it feeds the views ("PDF" button, "View
  // PDF"). Cover letters are LaTeX-only.
  const isDocxCv = cvSourceFormat === "docx";
  const selectedCvDownloadHref = !selectedJob
    ? "#"
    : isDocxCv
      ? `/pdfs/resume_${selectedJob.id}.docx?v=${encodeURIComponent(selectedJob.updatedAt)}`
      : selectedPdfHref;
  const canApply = selectedJob?.status === "ready";
  const canMoveToInProgress = selectedJob?.status === "applied";
  const canMarkClosed =
    selectedJob?.status === "applied" || selectedJob?.status === "in_progress";
  const isLive =
    selectedJob?.status === "applied" || selectedJob?.status === "in_progress";
  const hasDocuments =
    isLive && (!!selectedJob?.pdfPath || !!selectedJob?.coverLetterPdfPath);
  const canRowTailor =
    selectedJob?.status === "backlog" || selectedJob?.status === "stale";
  const canRowReopen =
    selectedJob?.status === "skipped" || selectedJob?.status === "closed";
  const canProcess = selectedJob
    ? ["discovered", "ready"].includes(selectedJob.status)
    : false;
  const canSkip = selectedJob
    ? ["discovered", "ready", "selected", "backlog"].includes(
        selectedJob.status,
      )
    : false;
  const canRowSkip = selectedJob?.status === "backlog";
  const showReadyPdf = activeTab === "tailoring";
  const showGeneratePdf = activeTab === "inbox";
  const isProcessingSelected = selectedJob
    ? processingJobId === selectedJob.id || selectedJob.status === "processing"
    : false;

  if (activeTab === "inbox") {
    return (
      <DiscoveredPanel
        job={selectedJob}
        onJobUpdated={onJobUpdated}
        onJobMoved={handleJobMoved}
        onTailoringDirtyChange={handleTailoringDirtyChange}
      />
    );
  }

  if (activeTab === "tailoring") {
    // Only finished (ready) rows get the ReadyPanel (PDF + ghostwriter).
    // Everything else routes to DiscoveredPanel, which renders the right
    // state itself: ProcessingState for in-flight rows, DecideMode for the
    // untailored candidates surfaced by the Untailored toggle, EmptyState
    // for none selected.
    if (selectedJob?.status === "ready") {
      return (
        <ReadyPanel
          job={selectedJob}
          onJobUpdated={onJobUpdated}
          onJobMoved={handleJobMoved}
          onTailoringDirtyChange={handleTailoringDirtyChange}
        />
      );
    }
    return (
      <DiscoveredPanel
        job={selectedJob}
        onJobUpdated={onJobUpdated}
        onJobMoved={handleJobMoved}
        onTailoringDirtyChange={handleTailoringDirtyChange}
      />
    );
  }

  if (!selectedJob) {
    return (
      <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1 text-center">
        <div className="text-sm font-medium text-muted-foreground">
          No job selected
        </div>
        <p className="text-xs text-muted-foreground/70">
          Select a job to view details
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold leading-tight">
            {selectedJob.title}
          </h2>
          <CompanyNameButton
            employer={selectedJob.employer}
            className="block max-w-full truncate text-sm text-muted-foreground"
          />
          {selectedJob.location ? (
            <p className="text-xs text-muted-foreground">
              {selectedJob.location}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <FitIndicator category={selectedJob.suitabilityCategory ?? null} />
          {selectedJob.outcome ? (
            <span className="inline-flex items-center rounded-full border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-bad))] bg-[color-mix(in_oklab,var(--badge-base)_85%,var(--badge-bad))] px-2.5 py-0.5 text-xs font-semibold text-rose-300">
              {outcomeLabel[selectedJob.outcome]}
            </span>
          ) : null}
          {selectedJob.status === "skipped" ? (
            <span className="inline-flex items-center rounded-full border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-warn))] bg-[color-mix(in_oklab,var(--badge-base)_85%,var(--badge-warn))] px-2.5 py-0.5 text-xs font-semibold text-amber-300">
              Skipped
            </span>
          ) : null}
        </div>
      </div>

      <FitAssessment job={selectedJob} />

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 text-xs"
        >
          <a href={selectedJobLink} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-3.5 w-3.5" />
            View
          </a>
        </Button>

        <JobStageSwitcher
          job={selectedJob}
          onJobUpdated={onJobUpdated}
          onJobMoved={handleJobMoved}
        />

        {showReadyPdf &&
          (selectedHasPdf ? (
            <Button
              asChild
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-xs"
            >
              <a
                href={selectedPdfHref}
                target="_blank"
                rel="noopener noreferrer"
              >
                <FileText className="h-3.5 w-3.5" />
                PDF
              </a>
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-xs"
              disabled
            >
              <FileText className="h-3.5 w-3.5" />
              PDF
            </Button>
          ))}

        {showGeneratePdf && (
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={handleProcess}
            disabled={!canProcess || isProcessingSelected}
          >
            {isProcessingSelected ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" />
            )}
            {isProcessingSelected ? "Generating..." : "Generate"}
          </Button>
        )}

        {canApply && (
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs bg-status-good/20 text-status-good-text hover:bg-status-good/30 border border-status-good/30"
            onClick={handleApply}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Applied
          </Button>
        )}

        {canMoveToInProgress && (
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs bg-accent-cyan/20 text-accent-cyan-text hover:bg-accent-cyan/30 border border-accent-cyan/30"
            onClick={handleMoveToInProgress}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Move to Interviewing
          </Button>
        )}

        {canMarkClosed && (
          <MarkClosedPopover
            onSelect={(outcome) => void handleMarkClosed(outcome)}
            trigger={
              <Button
                size="sm"
                className="h-8 gap-1.5 text-xs bg-status-bad/20 text-status-bad-text hover:bg-status-bad/30 border border-status-bad/30"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Mark Closed
              </Button>
            }
          />
        )}

        {canRowTailor && (
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs bg-accent-purple/20 text-accent-purple-text hover:bg-accent-purple/30 border border-accent-purple/30"
            onClick={handleTailorRow}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Tailor
          </Button>
        )}

        {canRowSkip && (
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs bg-status-bad/20 text-status-bad-text hover:bg-status-bad/30 border border-status-bad/30"
            onClick={() => void handleSkip()}
          >
            <XCircle className="h-3.5 w-3.5" />
            Skip
          </Button>
        )}

        {canRowReopen && (
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs bg-accent-cyan/20 text-accent-cyan-text hover:bg-accent-cyan/30 border border-accent-cyan/30"
            onClick={handleReopen}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Reopen
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="More actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canProcess && !showGeneratePdf && (
              <DropdownMenuItem
                onSelect={() => void handleProcess()}
                disabled={isProcessingSelected}
              >
                <RefreshCcw className="mr-2 h-4 w-4" />
                {isProcessingSelected
                  ? "Processing..."
                  : selectedJob.status === "ready"
                    ? "Regenerate PDF"
                    : "Generate PDF"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                setDetailTab("description");
                setIsEditingDescription(true);
              }}
            >
              <Edit2 className="mr-2 h-4 w-4" />
              Edit description
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={openEditDetails}>
              <Edit2 className="mr-2 h-4 w-4" />
              Edit details
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleCopyInfo()}>
              <Copy className="mr-2 h-4 w-4" />
              Copy info
            </DropdownMenuItem>
            {selectedHasPdf && (
              <>
                {!showReadyPdf && (
                  <DropdownMenuItem asChild>
                    <a
                      href={selectedPdfHref}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      View PDF
                    </a>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <a
                    href={selectedCvDownloadHref}
                    download={`${safeFilenamePart(personName || "Unknown")}_${safeFilenamePart(selectedJob.employer || "Unknown")}.${isDocxCv ? "docx" : "pdf"}`}
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    {isDocxCv ? "Download .docx" : "Download CV"}
                  </a>
                </DropdownMenuItem>
              </>
            )}
            {selectedHasCover && (
              <DropdownMenuItem asChild>
                <a
                  href={selectedCoverHref}
                  download={`${safeFilenamePart(personName || "Unknown")}_${safeFilenamePart(selectedJob.employer || "Unknown")}_Cover.pdf`}
                >
                  <FileText className="mr-2 h-4 w-4" />
                  Download Cover
                </a>
              </DropdownMenuItem>
            )}
            {canSkip && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => void handleSkip()}
                  className="text-destructive focus:text-destructive"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  Skip job
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Tabs
        value={detailTab}
        onValueChange={(value) => setDetailTab(value as typeof detailTab)}
      >
        <TabsList className="h-auto flex-wrap justify-start gap-1 text-xs">
          <TabsTrigger value="overview" className="text-xs">
            Overview
          </TabsTrigger>
          <TabsTrigger value="description" className="text-xs">
            Description
          </TabsTrigger>
          {hasDocuments && (
            <TabsTrigger value="documents" className="text-xs">
              Documents
            </TabsTrigger>
          )}
          {isLive && (
            <TabsTrigger value="interview" className="text-xs">
              Interview QA
            </TabsTrigger>
          )}
          {isLive && (
            <TabsTrigger value="notes" className="text-xs">
              Notes
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="overview" className="space-y-3 pt-2">
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <div className="text-[10px] text-muted-foreground/70 uppercase tracking-wide">
                Discipline
              </div>
              <div className="text-foreground/80">
                {selectedJob.disciplines || "-"}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground/70 uppercase tracking-wide">
                Function
              </div>
              <div className="text-foreground/80">
                {selectedJob.jobFunction || "-"}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground/70 uppercase tracking-wide">
                Level
              </div>
              <div className="text-foreground/80">
                {selectedJob.jobLevel || "-"}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground/70 uppercase tracking-wide">
                Type
              </div>
              <div className="text-foreground/80">
                {selectedJob.jobType || "-"}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <button
              type="button"
              className="w-full text-left rounded border border-border/30 bg-muted/5 px-2.5 py-2 text-[11px] text-muted-foreground/80 line-clamp-4 whitespace-pre-wrap leading-relaxed hover:bg-muted/10 transition-colors"
              onClick={() => setDetailTab("description")}
            >
              {description}
            </button>
            <div className="text-center">
              <button
                type="button"
                className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                onClick={() => setDetailTab("description")}
              >
                View full description
              </button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="description" className="space-y-3 pt-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Job description
            </div>
            <div className="flex items-center gap-1">
              {!isEditingDescription ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setIsEditingDescription(true)}
                  className="h-8 px-2 text-xs"
                >
                  <Edit2 className="mr-1.5 h-3.5 w-3.5" />
                  Edit
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setIsEditingDescription(false);
                      setEditedDescription(selectedJob.jobDescription || "");
                    }}
                    className="h-8 px-2 text-xs text-muted-foreground"
                    disabled={isSavingDescription}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleSaveDescription}
                    className="h-8 px-3 text-xs"
                    disabled={isSavingDescription}
                  >
                    {isSavingDescription ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Save Changes
                  </Button>
                </>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    aria-label="Description actions"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => {
                      void copyTextToClipboard(
                        selectedJob.jobDescription || "",
                      );
                      toast.success("Copied raw description");
                    }}
                  >
                    <Copy className="mr-2 h-4 w-4" />
                    Copy raw text
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/10 p-3 text-sm text-muted-foreground">
            {isEditingDescription ? (
              <div className="space-y-3">
                <Textarea
                  value={editedDescription}
                  onChange={(event) => setEditedDescription(event.target.value)}
                  className="min-h-[400px] font-mono text-sm leading-relaxed focus-visible:ring-1"
                  placeholder="Enter job description..."
                />
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setIsEditingDescription(false);
                      setEditedDescription(selectedJob.jobDescription || "");
                    }}
                    disabled={isSavingDescription}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveDescription}
                    disabled={isSavingDescription}
                  >
                    {isSavingDescription ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                    )}
                    Save Description
                  </Button>
                </div>
              </div>
            ) : renderMarkdownInJobDescriptions ? (
              <JobDescriptionMarkdown description={description} />
            ) : (
              <div className="whitespace-pre-wrap leading-relaxed">
                {description}
              </div>
            )}
          </div>
        </TabsContent>

        {hasDocuments && (
          <TabsContent value="documents" className="space-y-3 pt-3">
            <JobDocumentsPanel job={selectedJob} personName={personName} />
          </TabsContent>
        )}

        {isLive && (
          <TabsContent value="interview" className="space-y-3 pt-3">
            <InterviewQaSection job={selectedJob} onJobUpdated={onJobUpdated} />
          </TabsContent>
        )}

        {isLive && (
          <TabsContent value="notes" className="space-y-3 pt-3">
            <JobNotesSection jobId={selectedJob.id} />
          </TabsContent>
        )}
      </Tabs>

      <JobDetailsEditDrawer
        open={isEditDetailsOpen}
        onOpenChange={setIsEditDetailsOpen}
        job={selectedJob}
        onJobUpdated={onJobUpdated}
      />
    </div>
  );
};
