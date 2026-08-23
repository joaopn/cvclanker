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
  handleRerunSource: (source: JobSource, profileId?: string) => Promise<void>;
  // Re-run several sources in one partial run, one source at a time.
  handleRerunSources: (
    sources: JobSource[],
    profileId?: string,
  ) => Promise<void>;
};

// A provider-instance source id is `<provider>:<instanceId>`.
const providerInstanceIdOf = (source: JobSource): string => {
  const colonIndex = source.indexOf(":");
  return colonIndex > 0 ? source.slice(colonIndex + 1) : source;
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
      discoveryConcurrency?: number;
      scopeLabel?: string;
    }) => {
      try {
        setIsPipelineRunning(true);
        setIsCancelling(false);
        const started = await api.runPipeline({
          profileId: config.profileId,
          profileIds: config.profileIds,
          sources: config.sources,
          providerInstanceIds: config.providerInstanceIds,
          partial: config.partial,
          discoveryConcurrency: config.discoveryConcurrency,
        });
        const sources = config.sources ?? [];
        const scopeCount =
          sources.length + (config.providerInstanceIds?.length ?? 0);
        const profileCount = config.profileIds?.length ?? 0;
        const scopeLabel =
          config.scopeLabel ??
          (sources.length > 0
            ? `Sources: ${sources.join(", ")}`
            : scopeCount > 0
              ? `${scopeCount} source(s)`
              : profileCount > 1
                ? `${profileCount} profiles, one after another`
                : "Selected profile");
        // A partial run skips sources disabled since the run it retries.
        const skipped = started.skippedDisabledSources ?? [];
        const skippedNote =
          skipped.length > 0
            ? ` Skipped, disabled or removed on the Sources page: ${skipped.join(", ")}.`
            : "";
        toast.message("Pipeline started", {
          description: `${scopeLabel}.${skippedNote} This may take a few minutes.`,
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
    async (source: JobSource, profileId?: string) => {
      // Re-run a single source scoped to just this one, reconciled into the
      // existing banner funnel. The rest of the run config (location, terms,
      // budget) is resolved server-side from `profileId` — the Search Profile
      // whose page the row was clicked on — and from the default Profile when
      // the banner has no pages. Built-in extractors go through `sources`;
      // provider instances through `providerInstanceIds` — each path suppresses
      // the other.
      const isExtractor = isExtractorSourceId(source);

      await startPipelineRun({
        profileId,
        sources: isExtractor ? [source] : [],
        providerInstanceIds: isExtractor ? [] : [providerInstanceIdOf(source)],
        partial: true,
      });
    },
    [startPipelineRun],
  );

  const handleRerunSources = useCallback(
    async (sources: JobSource[], profileId?: string) => {
      if (sources.length === 0) return;
      // The single-run route does not refuse a start while a run is in
      // flight — the singleton guard drops it silently — so the check is here.
      if (isPipelineRunning) {
        toast.message("A pipeline run is already in progress");
        return;
      }
      const extractors = sources.filter(isExtractorSourceId);
      const instanceIds = sources
        .filter((source) => !isExtractorSourceId(source))
        .map(providerInstanceIdOf);

      // One partial run over every source, crawled one at a time — what the
      // per-row button does by hand, without a click and a wait per source.
      await startPipelineRun({
        profileId,
        sources: extractors,
        providerInstanceIds: instanceIds,
        partial: true,
        discoveryConcurrency: 1,
        scopeLabel: `Retrying ${sources.length} failed source(s), one at a time`,
      });
    },
    [isPipelineRunning, startPipelineRun],
  );

  return {
    isCancelling,
    runPipelineNow,
    handleCancelPipeline,
    handleRerunSource,
    handleRerunSources,
  };
}
