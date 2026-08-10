import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import { isExtractorSourceId } from "@shared/extractors";
import type { JobSource } from "@shared/types.js";
import { useCallback, useEffect, useState } from "react";

type UsePipelineControlsArgs = {
  isPipelineRunning: boolean;
  setIsPipelineRunning: (value: boolean) => void;
  pipelineTerminalEvent: { status: string; errorMessage: string | null } | null;
};

export type UsePipelineControlsResult = {
  isCancelling: boolean;
  runPipelineNow: (profileIds?: string[]) => Promise<void>;
  handleCancelPipeline: () => Promise<void>;
  handleRerunSource: (source: JobSource) => Promise<void>;
};

export function usePipelineControls(
  args: UsePipelineControlsArgs,
): UsePipelineControlsResult {
  const { isPipelineRunning, setIsPipelineRunning, pipelineTerminalEvent } =
    args;

  const [isCancelling, setIsCancelling] = useState(false);

  useEffect(() => {
    if (!pipelineTerminalEvent) return;
    setIsPipelineRunning(false);
    setIsCancelling(false);

    if (pipelineTerminalEvent.status === "cancelled") {
      toast.message("Pipeline cancelled");
      return;
    }

    if (pipelineTerminalEvent.status === "failed") {
      toast.error(pipelineTerminalEvent.errorMessage || "Pipeline failed");
      return;
    }

    toast.success("Pipeline completed");
  }, [pipelineTerminalEvent, setIsPipelineRunning]);

  const startPipelineRun = useCallback(
    async (config: {
      profileId?: string;
      profileIds?: string[];
      sources?: JobSource[];
      providerInstanceIds?: string[];
      partial?: boolean;
    }) => {
      try {
        setIsPipelineRunning(true);
        setIsCancelling(false);
        await api.runPipeline({
          profileId: config.profileId,
          profileIds: config.profileIds,
          sources: config.sources,
          providerInstanceIds: config.providerInstanceIds,
          partial: config.partial,
        });
        const sources = config.sources ?? [];
        const scopeCount =
          sources.length + (config.providerInstanceIds?.length ?? 0);
        const profileCount = config.profileIds?.length ?? 0;
        const scopeLabel =
          sources.length > 0
            ? `Sources: ${sources.join(", ")}`
            : scopeCount > 0
              ? `${scopeCount} source(s)`
              : profileCount > 1
                ? `${profileCount} profiles, one after another`
                : "Selected profile";
        toast.message("Pipeline started", {
          description: `${scopeLabel}. This may take a few minutes.`,
        });
      } catch (error) {
        setIsPipelineRunning(false);
        setIsCancelling(false);
        const message =
          error instanceof Error ? error.message : "Failed to start pipeline";
        toast.error(message);
      }
    },
    [setIsPipelineRunning],
  );

  const runPipelineNow = useCallback(
    async (profileIds?: string[]) => {
      // One profile keeps the single-run shape (`profileId`), which the server
      // runs directly; several go through `profileIds` and the sequence runner.
      if (profileIds && profileIds.length > 1) {
        await startPipelineRun({ profileIds });
        return;
      }
      await startPipelineRun({ profileId: profileIds?.[0] });
    },
    [startPipelineRun],
  );

  const handleCancelPipeline = useCallback(async () => {
    if (isCancelling || !isPipelineRunning) return;

    try {
      setIsCancelling(true);
      const result = await api.cancelPipeline();
      toast.message(result.message);
    } catch (error) {
      setIsCancelling(false);
      const message =
        error instanceof Error ? error.message : "Failed to cancel pipeline";
      toast.error(message);
    }
  }, [isCancelling, isPipelineRunning]);

  const handleRerunSource = useCallback(
    async (source: JobSource) => {
      // Re-run a single source scoped to just this one, reconciled into the
      // existing banner funnel. The rest of the run config (location, terms,
      // budget) is resolved server-side from the default Profile. Built-in
      // extractors go through `sources`; provider instances through
      // `providerInstanceIds` — each path suppresses the other.
      const isExtractor = isExtractorSourceId(source);
      const colonIndex = source.indexOf(":");
      const instanceId = colonIndex > 0 ? source.slice(colonIndex + 1) : source;

      await startPipelineRun({
        sources: isExtractor ? [source] : [],
        providerInstanceIds: isExtractor ? [] : [instanceId],
        partial: true,
      });
    },
    [startPipelineRun],
  );

  return {
    isCancelling,
    runPipelineNow,
    handleCancelPipeline,
    handleRerunSource,
  };
}
