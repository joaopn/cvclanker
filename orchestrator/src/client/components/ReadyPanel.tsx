import type { Job } from "@shared/types.js";
import {
  CheckCircle2,
  Copy,
  Download,
  Edit2,
  ExternalLink,
  FileText,
  Filter,
  Loader2,
  MoreHorizontal,
  RefreshCcw,
  Undo2,
  XCircle,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@client/lib/toast";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  cn,
  copyTextToClipboard,
  formatJobForWebhook,
  safeFilenamePart,
} from "@/lib/utils";
import { getRenderableJobDescription } from "@/client/lib/jobDescription";
import { restoreJobStates, snapshotJob } from "@client/lib/undo";
import { useUndo } from "@client/pages/orchestrator/useUndoController";
import * as api from "../api";
import {
  useMarkAsAppliedMutation,
  useSkipJobMutation,
} from "../hooks/queries/useJobMutations";
import { useActiveCv } from "../hooks/useActiveCv";
import { useRescoreJob } from "../hooks/useRescoreJob";
import { useResizablePanel } from "../hooks/useResizableListPanel";
import { useSettings } from "../hooks/useSettings";
import { CompanyNameButton } from "../pages/orchestrator/CompanyNameButton";
import { JobStageSwitcher } from "../pages/orchestrator/JobStageSwitcher";
import { FitAssessment } from ".";
import { CollapsibleSection } from "./discovered-panel/CollapsibleSection";
import { AtsCoverageBadge } from "./ghostwriter/AtsCoverageBadge";
import { BriefPane } from "./ghostwriter/BriefPane";
import { CoverLetterPane } from "./ghostwriter/CoverLetterPane";
import { CvPane } from "./ghostwriter/CvPane";
import { GhostwriterPanel } from "./ghostwriter/GhostwriterPanel";
import { TailorColumnSplitter } from "./ghostwriter/TailorColumnSplitter";
import { JobDescriptionMarkdown } from "./JobDescriptionMarkdown";
import { JobDetailsEditDrawer } from "./JobDetailsEditDrawer";
import { KbdHint } from "./KbdHint";
import { OpenJobListingButton } from "./OpenJobListingButton";
import { ReadySummaryAccordion } from "./ReadySummaryAccordion";
import { FitIndicator } from "./ScoreIndicator";
import { buildReadyPanelGoogleDorks } from "./ready-panel-google-dorks";

const TAILOR_PANEL_STORAGE_KEY = "cvclanker:tailorPanel:rightWidth";
const TAILOR_PANEL_DEFAULT_WIDTH = 380;
const TAILOR_PANEL_MIN_WIDTH = 200;
const TAILOR_PANEL_MAX_WIDTH = 4000;

const READY_TAB_STORAGE_KEY = "cvclanker:ready-tab";
type ReadyTab = "tailor-cv" | "tailor-cover" | "brief" | "details";

function readInitialReadyTab(): ReadyTab {
  if (typeof window === "undefined") return "tailor-cv";
  const raw = window.localStorage.getItem(READY_TAB_STORAGE_KEY);
  if (
    raw === "tailor-cv" ||
    raw === "tailor-cover" ||
    raw === "brief" ||
    raw === "details"
  ) {
    return raw;
  }
  return "tailor-cv";
}

interface ReadyPanelProps {
  job: Job | null;
  onJobUpdated: () => void | Promise<void>;
  onJobMoved: (jobId: string) => void;
  onTailoringDirtyChange?: (isDirty: boolean) => void;
}

export const ReadyPanel: React.FC<ReadyPanelProps> = ({
  job,
  onJobUpdated,
  onJobMoved,
  onTailoringDirtyChange,
}) => {
  const [isMarkingApplied, setIsMarkingApplied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isRefreshingAts, setIsRefreshingAts] = useState(false);
  const [isEditDetailsOpen, setIsEditDetailsOpen] = useState(false);
  const [isMovingBackToInbox, setIsMovingBackToInbox] = useState(false);
  const [showDescription, setShowDescription] = useState(false);
  const { isRescoring, rescoreJob } = useRescoreJob(onJobUpdated);
  const {
    cvSourceFormat,
    renderMarkdownInJobDescriptions,
    hasScorerPrefilter,
  } = useSettings();
  const { pushUndo, undo } = useUndo();
  const previousJobIdRef = useRef<string | null>(null);
  const markAsAppliedMutation = useMarkAsAppliedMutation();
  const skipJobMutation = useSkipJobMutation();

  const { cv, personName } = useActiveCv();
  const [activeTab, setActiveTab] = useState<ReadyTab>(readInitialReadyTab);
  const [pendingCoverLetter, setPendingCoverLetter] = useState<string | null>(
    null,
  );

  const {
    width: rightColumnWidth,
    isDragging,
    startDrag,
  } = useResizablePanel({
    storageKey: TAILOR_PANEL_STORAGE_KEY,
    defaultWidth: TAILOR_PANEL_DEFAULT_WIDTH,
    minWidth: TAILOR_PANEL_MIN_WIDTH,
    maxWidth: TAILOR_PANEL_MAX_WIDTH,
    invertDelta: true,
  });

  const openEditDetails = useCallback(() => {
    window.setTimeout(() => setIsEditDetailsOpen(true), 0);
  }, []);

  useEffect(() => {
    const currentJobId = job?.id ?? null;
    if (previousJobIdRef.current === currentJobId) return;
    previousJobIdRef.current = currentJobId;
    setIsEditDetailsOpen(false);
    setShowDescription(false);
    onTailoringDirtyChange?.(false);
  }, [job?.id, onTailoringDirtyChange]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(READY_TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  // Compute derived values
  const pdfHref = job
    ? `/pdfs/resume_${job.id}.pdf?v=${encodeURIComponent(job.updatedAt)}`
    : "#";

  const coverPdfHref = job
    ? `/pdfs/cover_letter_${job.id}.pdf?v=${encodeURIComponent(job.updatedAt)}`
    : "#";

  // On a Word profile the tailored .docx is the artifact you download; the PDF
  // stays a view (the preview iframe and "View PDF"). Cover letters are
  // LaTeX-only, so coverPdfHref is unconditional.
  const isDocxCv = cvSourceFormat === "docx";
  const cvDownloadHref = !job
    ? "#"
    : isDocxCv
      ? `/pdfs/resume_${job.id}.docx?v=${encodeURIComponent(job.updatedAt)}`
      : pdfHref;

  const hasCoverPdf = Boolean(job?.coverLetterPdfPath);

  const atsKeywordCount =
    (job?.tailoringMatched?.length ?? 0) + (job?.tailoringSkipped?.length ?? 0);

  const jobLink = job ? job.applicationLink || job.jobUrl : "#";

  const googleDorks = useMemo(
    () => (job ? buildReadyPanelGoogleDorks(job) : []),
    [job],
  );

  const description = useMemo(
    () => getRenderableJobDescription(job?.jobDescription),
    [job?.jobDescription],
  );

  // Handle mark as applied with undo (routed through the shared controller so
  // the toolbar button + Ctrl/Cmd+Z also revert it).
  const handleMarkApplied = useCallback(async () => {
    if (!job) return;

    try {
      setIsMarkingApplied(true);
      const snap = snapshotJob(job);
      await markAsAppliedMutation.mutateAsync(job.id);

      pushUndo({
        label: "Mark applied",
        restore: async () => {
          await restoreJobStates([snap]);
        },
      });

      // Notify parent to move to next job
      onJobMoved(job.id);
      await onJobUpdated();

      toast.success("Marked as applied", {
        description: `${job.title} at ${job.employer}`,
        action: { label: "Undo", onClick: () => undo() },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to mark as applied";
      toast.error(message);
    } finally {
      setIsMarkingApplied(false);
    }
  }, [job, markAsAppliedMutation, onJobMoved, onJobUpdated, pushUndo, undo]);

  const handleRegenerate = useCallback(async () => {
    if (!job) return;

    try {
      setIsRegenerating(true);
      await api.generateJobPdf(job.id);
      toast.success("PDF regenerated");
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to regenerate PDF";
      toast.error(message);
    } finally {
      setIsRegenerating(false);
    }
  }, [job, onJobUpdated]);

  const handleRescore = useCallback(
    () => rescoreJob(job?.id),
    [job?.id, rescoreJob],
  );

  const handleScreenRescore = useCallback(
    () => rescoreJob(job?.id, { prefilter: true }),
    [job?.id, rescoreJob],
  );

  const handleRefreshAts = useCallback(async () => {
    if (!job) return;
    try {
      setIsRefreshingAts(true);
      await api.refreshAtsCoverage(job.id);
      toast.success("ATS coverage refreshed");
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to refresh ATS coverage";
      toast.error(message);
    } finally {
      setIsRefreshingAts(false);
    }
  }, [job, onJobUpdated]);

  const handleSkip = useCallback(async () => {
    if (!job) return;

    try {
      await skipJobMutation.mutateAsync(job.id);
      toast.message("Job skipped");
      onJobMoved(job.id);
      await onJobUpdated();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to skip";
      toast.error(message);
    }
  }, [job, onJobMoved, onJobUpdated, skipJobMutation]);

  const handleMoveBackToInbox = useCallback(async () => {
    if (!job) return;

    try {
      setIsMovingBackToInbox(true);
      await api.updateJob(job.id, { status: "discovered" });
      toast.success("Moved back to Inbox", {
        description: "Re-tailor from the Inbox to apply CV/brief updates.",
      });
      onJobMoved(job.id);
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to move job back to Inbox";
      toast.error(message);
    } finally {
      setIsMovingBackToInbox(false);
    }
  }, [job, onJobMoved, onJobUpdated]);

  const handleCopyInfo = useCallback(async () => {
    if (!job) return;

    try {
      await copyTextToClipboard(formatJobForWebhook(job));
      toast.success("Copied job info", {
        description: "Webhook payload copied to clipboard.",
      });
    } catch {
      toast.error("Could not copy job info");
    }
  }, [job]);

  const handleUseAsCoverLetter = useCallback(
    async (content: string) => {
      if (!job) return;
      // Optimistically reflect the pasted content; the cover-letter pane
      // re-syncs from the server-confirmed job once `onJobUpdated` resolves.
      setPendingCoverLetter(content);
      try {
        await api.updateJob(job.id, { coverLetterDraft: content });
        toast.success("Saved as cover-letter draft");
        await onJobUpdated();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to save cover letter";
        toast.error(message);
      } finally {
        setPendingCoverLetter(null);
      }
    },
    [job, onJobUpdated],
  );

  // Empty state
  if (!job) {
    return (
      <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-2 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/30">
          <FileText className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="text-sm font-medium text-muted-foreground">
          No job selected
        </div>
        <p className="text-xs text-muted-foreground/70 max-w-[200px]">
          Select a Ready job to view its application kit and take action.
        </p>
      </div>
    );
  }

  const coverLetterJob: Job =
    pendingCoverLetter !== null
      ? { ...job, coverLetterDraft: pendingCoverLetter }
      : job;

  const showRightColumn = activeTab !== "details";

  const tailorGridStyle = showRightColumn
    ? {
        gridTemplateColumns: `minmax(0, 1fr) auto ${rightColumnWidth}px`,
      }
    : { gridTemplateColumns: "minmax(0, 1fr)" };

  return (
    <div className="flex flex-col h-full">
      {/* ─────────────────────────────────────────────────────────────────────
          HEADER ROW: title + fit on the left, primary actions on the right
      ───────────────────────────────────────────────────────────────────── */}
      <div className="pb-4 border-b border-border/40">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold leading-tight">
                {job.title}
              </h2>
              <CompanyNameButton
                employer={job.employer}
                className="block max-w-full truncate text-sm text-muted-foreground"
              />
              {job.location ? (
                <p className="text-xs text-muted-foreground">{job.location}</p>
              ) : null}
            </div>
            <FitIndicator category={job.suitabilityCategory ?? null} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              asChild
              variant="outline"
              className="h-9 gap-1 px-2 text-xs"
            >
              <a
                href={cvDownloadHref}
                download={`${safeFilenamePart(personName || "Unknown")}_${safeFilenamePart(job.employer || "Unknown")}.${isDocxCv ? "docx" : "pdf"}`}
              >
                <Download className="h-3.5 w-3.5 shrink-0" />
                <span>{isDocxCv ? "Download .docx" : "Download CV"}</span>
                <KbdHint shortcut="d" className="ml-1" />
              </a>
            </Button>

            {hasCoverPdf ? (
              <Button
                asChild
                variant="outline"
                className="h-9 gap-1 px-2 text-xs"
              >
                <a
                  href={coverPdfHref}
                  download={`${safeFilenamePart(personName || "Unknown")}_${safeFilenamePart(job.employer || "Unknown")}_Cover.pdf`}
                >
                  <Download className="h-3.5 w-3.5 shrink-0" />
                  <span>Download Cover</span>
                </a>
              </Button>
            ) : (
              <Button
                variant="outline"
                className="h-9 gap-1 px-2 text-xs"
                disabled
                title="Render the cover letter first (Tailor Cover Letter tab)"
              >
                <Download className="h-3.5 w-3.5 shrink-0" />
                <span>Download Cover</span>
              </Button>
            )}

            <OpenJobListingButton
              href={jobLink}
              className="h-9 px-2 text-xs"
              shortcut="o"
            />

            <JobStageSwitcher
              job={job}
              onJobUpdated={onJobUpdated}
              onJobMoved={onJobMoved}
              className="h-9"
            />

            <Button
              onClick={handleMarkApplied}
              variant="default"
              className="h-9 gap-1 px-2 text-xs"
              disabled={isMarkingApplied}
            >
              {isMarkingApplied ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
              <span>Mark Applied</span>
              <KbdHint shortcut="a" className="ml-1" />
            </Button>
          </div>
        </div>
      </div>

      <div className="py-3">
        <FitAssessment job={job} />
      </div>

      <div className="flex-1 min-h-0 py-4 flex flex-col">
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <TabTrigger
            active={activeTab === "tailor-cv"}
            onClick={() => setActiveTab("tailor-cv")}
          >
            Tailor CV
          </TabTrigger>
          <TabTrigger
            active={activeTab === "tailor-cover"}
            onClick={() => setActiveTab("tailor-cover")}
          >
            Tailor Cover Letter
          </TabTrigger>
          <TabTrigger
            active={activeTab === "brief"}
            onClick={() => setActiveTab("brief")}
          >
            Personal Brief
          </TabTrigger>
          <TabTrigger
            active={activeTab === "details"}
            onClick={() => setActiveTab("details")}
          >
            Details
          </TabTrigger>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                aria-label="More actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onSelect={openEditDetails}>
                <Edit2 className="mr-2 h-4 w-4" />
                Edit details
              </DropdownMenuItem>

              <DropdownMenuItem
                onSelect={handleRegenerate}
                disabled={isRegenerating}
              >
                <RefreshCcw
                  className={cn(
                    "mr-2 h-4 w-4",
                    isRegenerating && "animate-spin",
                  )}
                />
                {isRegenerating ? "Regenerating..." : "Regenerate PDF"}
              </DropdownMenuItem>

              <DropdownMenuItem onSelect={handleRescore} disabled={isRescoring}>
                <RefreshCcw
                  className={cn("mr-2 h-4 w-4", isRescoring && "animate-spin")}
                />
                {isRescoring ? "Recalculating..." : "Recalculate fit"}
              </DropdownMenuItem>

              {hasScorerPrefilter ? (
                <DropdownMenuItem
                  onSelect={handleScreenRescore}
                  disabled={isRescoring}
                >
                  <Filter className="mr-2 h-4 w-4" />
                  Screen first, then recalculate
                </DropdownMenuItem>
              ) : null}

              <DropdownMenuSeparator />

              {/* Utility actions */}
              <DropdownMenuItem
                onSelect={() =>
                  window.open(pdfHref, "_blank", "noopener,noreferrer")
                }
              >
                <FileText className="mr-2 h-4 w-4" />
                View PDF
              </DropdownMenuItem>

              <DropdownMenuItem onSelect={handleCopyInfo}>
                <Copy className="mr-2 h-4 w-4" />
                Copy job info
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              <DropdownMenuItem
                onSelect={handleMoveBackToInbox}
                disabled={isMovingBackToInbox}
              >
                <Undo2 className="mr-2 h-4 w-4" />
                {isMovingBackToInbox ? "Moving back..." : "Move back to Inbox"}
              </DropdownMenuItem>

              <DropdownMenuSeparator />

              {/* Destructive actions */}
              <DropdownMenuItem
                onSelect={handleSkip}
                className="text-destructive focus:text-destructive"
              >
                <XCircle className="mr-2 h-4 w-4" />
                Skip this job
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div
          className="grid flex-1 min-h-0 gap-0"
          style={tailorGridStyle}
        >
          <div className="flex min-h-0 min-w-0 flex-col">
            {activeTab === "tailor-cv" ? (
              <div className="flex h-full min-h-0 flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <AtsCoverageBadge job={job} />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={handleRefreshAts}
                    disabled={isRefreshingAts || atsKeywordCount === 0}
                    title={
                      atsKeywordCount === 0
                        ? "Tailor the job first to populate keywords."
                        : "Recompute coverage against the current CV"
                    }
                  >
                    <RefreshCcw
                      className={cn(
                        "h-3.5 w-3.5",
                        isRefreshingAts && "animate-spin",
                      )}
                    />
                    Refresh
                  </Button>
                </div>
                <div className="min-h-[420px] flex-1">
                  <CvPane job={job} onJobUpdated={onJobUpdated} />
                </div>
              </div>
            ) : null}

            {activeTab === "tailor-cover" ? (
              <div className="flex h-full min-h-[420px] flex-col">
                <CoverLetterPane
                  job={coverLetterJob}
                  onJobUpdated={onJobUpdated}
                />
              </div>
            ) : null}

            {activeTab === "brief" ? (
              <div className="flex h-full min-h-[420px] flex-col">
                <BriefPane
                  jobId={job.id}
                  cvId={cv?.id ?? null}
                  brief={cv?.personalBrief ?? ""}
                  onJobUpdated={onJobUpdated}
                />
              </div>
            ) : null}

            {activeTab === "details" ? (
              <div className="space-y-3">
                <CollapsibleSection
                  isOpen={showDescription}
                  onToggle={() => setShowDescription((prev) => !prev)}
                  label={`${showDescription ? "Hide" : "View"} Full Job Description`}
                >
                  <div className="rounded-xl border border-border/40 bg-muted/5 p-4 mt-2 max-h-[400px] overflow-y-auto shadow-inner">
                    {renderMarkdownInJobDescriptions ? (
                      <JobDescriptionMarkdown description={description} />
                    ) : (
                      <p className="text-xs text-muted-foreground/90 whitespace-pre-wrap leading-relaxed">
                        {description}
                      </p>
                    )}
                  </div>
                </CollapsibleSection>

                {googleDorks.length > 0 ? (
                  <ReadySummaryAccordion
                    icon={ExternalLink}
                    summary={
                      <>
                        {googleDorks.length}{" "}
                        {googleDorks.length === 1
                          ? "search link"
                          : "search links"}
                      </>
                    }
                    value="search-dorks"
                  >
                    <div className="text-muted-foreground flex flex-col items-start gap-2">
                      {googleDorks.map((dork) => (
                        <a
                          key={dork.query}
                          href={dork.href}
                          rel="noopener noreferrer"
                          target="_blank"
                          title={dork.query}
                          className={cn(
                            buttonVariants({ variant: "link", size: "sm" }),
                            "justify-start w-fit h-fit gap-1 px-0 wrap-break-word",
                          )}
                        >
                          {dork.label}
                          <ExternalLink className="ml-1" />
                        </a>
                      ))}
                    </div>
                  </ReadySummaryAccordion>
                ) : null}
              </div>
            ) : null}
          </div>

          {showRightColumn ? (
            <TailorColumnSplitter
              onDrag={startDrag}
              isDragging={isDragging}
              width={rightColumnWidth}
              minWidth={TAILOR_PANEL_MIN_WIDTH}
              maxWidth={TAILOR_PANEL_MAX_WIDTH}
            />
          ) : null}

          {showRightColumn ? (
            <div className="flex min-h-0 min-w-0 flex-col rounded-md border border-border/60 bg-background p-3">
              <GhostwriterPanel
                job={job}
                onJobUpdated={onJobUpdated}
                onUseAsCoverLetter={handleUseAsCoverLetter}
              />
            </div>
          ) : null}
        </div>
      </div>

      <JobDetailsEditDrawer
        open={isEditDetailsOpen}
        onOpenChange={setIsEditDetailsOpen}
        job={job}
        onJobUpdated={onJobUpdated}
      />
    </div>
  );
};

const TabTrigger: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
      active
        ? "bg-muted text-foreground"
        : "text-muted-foreground hover:bg-muted/40",
    )}
  >
    {children}
  </button>
);
