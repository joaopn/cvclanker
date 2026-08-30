import { ActivityLogButton } from "@client/components/ActivityLogButton";
import { PageHeader, StatusIndicator } from "@client/components/layout";
import { ViewToggle } from "@client/components/ViewToggle";
import type { JobSource } from "@shared/types.js";
import {
  Activity,
  Clock,
  Link as LinkIcon,
  Loader2,
  RotateCcw,
  Square,
} from "lucide-react";
import type React from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface OrchestratorHeaderProps {
  navOpen: boolean;
  onNavOpenChange: (open: boolean) => void;
  isPipelineRunning: boolean;
  /** A run in the SCHEDULE partition. Locks the Run control without swapping
   *  in Cancel — that run belongs to the Schedule tab, not to this one. */
  scheduledRunActive?: boolean;
  isCancelling: boolean;
  pipelineSources: JobSource[];
  onOpenBatchUrlImport: () => void;
  onOpenLlmQueue: () => void;
  llmActiveCount: number;
  onCancelPipeline: () => void;
  canUndo: boolean;
  undoLabel: string | null;
  onUndo: () => void;
  profileSelect?: React.ReactNode;
  /** The Run button and its scoping menu. Required: there is no plain-button
   * fallback, so the header cannot render a Run control that bypasses it. */
  runControl: React.ReactNode;
}

export const OrchestratorHeader: React.FC<OrchestratorHeaderProps> = ({
  navOpen,
  onNavOpenChange,
  isPipelineRunning,
  scheduledRunActive = false,
  isCancelling,
  pipelineSources,
  onOpenBatchUrlImport,
  onOpenLlmQueue,
  llmActiveCount,
  onCancelPipeline,
  canUndo,
  undoLabel,
  onUndo,
  profileSelect,
  runControl,
}) => {
  const undoButton = (
    <Button
      size="sm"
      variant="ghost"
      onClick={onUndo}
      disabled={!canUndo}
      className="gap-2"
      title={canUndo ? `Undo: ${undoLabel}` : "Nothing to undo"}
      aria-label="Undo last action"
    >
      <RotateCcw className="h-4 w-4" />
      <span className="hidden sm:inline">Undo</span>
    </Button>
  );

  const queueButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={onOpenLlmQueue}
      className="relative gap-2"
      aria-label="LLM call queue"
    >
      <Activity className="h-4 w-4" />
      <span className="hidden sm:inline">LLM</span>
      {llmActiveCount > 0 && (
        <Badge
          variant="default"
          className="h-5 min-w-[1.25rem] justify-center px-1 text-[10px]"
        >
          {llmActiveCount}
        </Badge>
      )}
    </Button>
  );

  // The pipeline is a process-wide singleton, so a scheduled run makes a manual
  // one impossible: the run route 409s every request while a sequence is
  // active. Offering the button anyway would just hand the user a conflict
  // toast. Not a Cancel swap — that run is the Schedule tab's to stop, not this
  // page's.
  const scheduledRunNotice = (
    <Link
      to="/schedule"
      className="inline-flex items-center gap-2 rounded-md border border-status-warn/30 bg-status-warn/10 px-3 py-1.5 text-sm text-status-warn-text"
    >
      <Clock className="h-4 w-4" />
      <span className="hidden sm:inline">Scheduled run in progress</span>
    </Link>
  );

  const actions = isPipelineRunning ? (
    <div className="flex items-center gap-2">
      {profileSelect}
      {undoButton}
      <ActivityLogButton />
      {queueButton}
      <Button
        size="sm"
        onClick={onCancelPipeline}
        disabled={isCancelling}
        variant="destructive"
        className="gap-2"
      >
        {isCancelling ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Square className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">
          {isCancelling
            ? `Cancelling (${pipelineSources.length})`
            : `Cancel run`}
        </span>
      </Button>
    </div>
  ) : (
    <div className="flex items-center gap-2">
      {profileSelect}
      {undoButton}
      <ActivityLogButton />
      {queueButton}
      <Button
        size="sm"
        variant="outline"
        onClick={onOpenBatchUrlImport}
        className="gap-2"
      >
        <LinkIcon className="h-4 w-4" />
        <span className="hidden sm:inline">Fetch URLs</span>
      </Button>
      {scheduledRunActive ? scheduledRunNotice : runControl}
    </div>
  );

  return (
    <PageHeader
      brand={
        <span className="whitespace-nowrap text-lg font-semibold tracking-tight">
          CV Clanker
        </span>
      }
      title="CV Clanker"
      subtitle="Orchestrator"
      titleSlot={<ViewToggle />}
      navOpen={navOpen}
      onNavOpenChange={onNavOpenChange}
      statusIndicator={
        isPipelineRunning ? (
          <StatusIndicator label="Pipeline running" variant="amber" />
        ) : scheduledRunActive ? (
          <StatusIndicator label="Scheduled run" variant="amber" />
        ) : undefined
      }
      actions={actions}
      fullWidth
    />
  );
};
