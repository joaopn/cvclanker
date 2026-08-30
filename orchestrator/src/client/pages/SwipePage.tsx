/**
 * Mobile-first "Swipe" surface: a Tinder-style deck for triaging the
 * discovered-job inbox. Shares the job-status model and pipeline with the
 * full "Manage" orchestrator; only the presentation differs.
 */

import { PageHeader } from "@client/components/layout";
import { PipelineProgressStrip } from "@client/components/PipelineProgressStrip";
import { ViewToggle } from "@client/components/ViewToggle";
import type { JobStatus } from "@shared/types";
import { Clock, Loader2, Play, Square } from "lucide-react";
import type React from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ProfileSelect } from "./orchestrator/ProfileSelect";
import { useOrchestratorData } from "./orchestrator/useOrchestratorData";
import { usePipelineControls } from "./orchestrator/usePipelineControls";
import { useSelectedProfile } from "./orchestrator/useSelectedProfile";
import { SwipeDeck } from "./swipe/SwipeDeck";

// The deck triages the Inbox only — scope the shared data hook to it so this
// surface never fetches the whole jobs table (it reads only pipeline state;
// the deck itself queries its own cards).
const SWIPE_SCOPE: JobStatus[] = ["discovered"];

export const SwipePage: React.FC = () => {
  const {
    isPipelineRunning,
    scheduledRunActive,
    setIsPipelineRunning,
    pipelineTerminalEvent,
  } = useOrchestratorData(null, false, SWIPE_SCOPE);

  const { isCancelling, runPipelineNow, handleCancelPipeline } =
    usePipelineControls({
      isPipelineRunning,
      setIsPipelineRunning,
      pipelineTerminalEvent,
    });

  const { profiles, selectedProfileIds, toggleProfile } = useSelectedProfile();

  const profileSelect = (
    <ProfileSelect
      profiles={profiles}
      selectedProfileIds={selectedProfileIds}
      onToggle={toggleProfile}
    />
  );

  const actions = isPipelineRunning ? (
    <div className="flex items-center gap-2">
      {profileSelect}
      <Button
        size="sm"
        variant="destructive"
        onClick={handleCancelPipeline}
        disabled={isCancelling}
        className="gap-2"
      >
        {isCancelling ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Square className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">Cancel run</span>
      </Button>
    </div>
  ) : (
    <div className="flex items-center gap-2">
      {profileSelect}
      {scheduledRunActive ? (
        // The pipeline is a singleton, so a scheduled run makes a manual one
        // impossible — the run route 409s while a sequence is active, so the
        // button could only produce a conflict toast. That run belongs to the
        // Runs tab, so this links there rather than offering a Cancel this
        // page does not own.
        <Link
          to="/runs"
          className="inline-flex items-center gap-2 rounded-md border border-status-warn/30 bg-status-warn/10 px-3 py-1.5 text-sm text-status-warn-text"
        >
          <Clock className="h-4 w-4" />
          <span className="hidden sm:inline">Scheduled run</span>
        </Link>
      ) : (
        <Button
          size="sm"
          onClick={() => runPipelineNow(selectedProfileIds)}
          className="gap-2"
        >
          <Play className="h-4 w-4" />
          <span className="hidden sm:inline">Run pipeline</span>
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <PageHeader
        brand={
          <span className="whitespace-nowrap text-lg font-semibold tracking-tight">
            CV Clanker
          </span>
        }
        title="CV Clanker"
        subtitle="Swipe"
        titleSlot={<ViewToggle />}
        actions={actions}
        fullWidth
        inlineActions
      />

      <PipelineProgressStrip isRunning={isPipelineRunning} />

      <main className="flex min-h-0 flex-1 flex-col px-4 pb-[env(safe-area-inset-bottom)] pt-4">
        <SwipeDeck
          pipelineTerminalEvent={pipelineTerminalEvent}
          isPipelineRunning={isPipelineRunning}
          onRunPipeline={() => runPipelineNow(selectedProfileIds)}
          profiles={profiles}
        />
      </main>
    </div>
  );
};
