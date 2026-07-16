/**
 * Mobile-first "Swipe" surface: a Tinder-style deck for triaging the
 * discovered-job inbox. Shares the job-status model and pipeline with the
 * full "Manage" orchestrator; only the presentation differs.
 */

import { PageHeader } from "@client/components/layout";
import { PipelineProgressStrip } from "@client/components/PipelineProgressStrip";
import { ViewToggle } from "@client/components/ViewToggle";
import { Loader2, Play, Square } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { ProfileSelect } from "./orchestrator/ProfileSelect";
import { useOrchestratorData } from "./orchestrator/useOrchestratorData";
import { usePipelineControls } from "./orchestrator/usePipelineControls";
import { useSelectedProfile } from "./orchestrator/useSelectedProfile";
import { SwipeDeck } from "./swipe/SwipeDeck";

export const SwipePage: React.FC = () => {
  const { isPipelineRunning, setIsPipelineRunning, pipelineTerminalEvent } =
    useOrchestratorData(null);

  const { isCancelling, runPipelineNow, handleCancelPipeline } =
    usePipelineControls({
      isPipelineRunning,
      setIsPipelineRunning,
      pipelineTerminalEvent,
    });

  const {
    profiles,
    selectedProfileId,
    setSelected: setSelectedProfile,
  } = useSelectedProfile();

  const profileSelect = (
    <ProfileSelect
      profiles={profiles}
      selectedProfileId={selectedProfileId}
      onSelect={setSelectedProfile}
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
      <Button
        size="sm"
        onClick={() => runPipelineNow(selectedProfileId ?? undefined)}
        className="gap-2"
      >
        <Play className="h-4 w-4" />
        <span className="hidden sm:inline">Run pipeline</span>
      </Button>
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
          onRunPipeline={() => runPipelineNow(selectedProfileId ?? undefined)}
        />
      </main>
    </div>
  );
};
