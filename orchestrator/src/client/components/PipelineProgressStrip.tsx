/**
 * Compact, mobile-friendly pipeline-progress indicator for the Swipe page.
 * Reads the same progress feed as the desktop PipelineRunBanner, but renders a
 * single slim row + thin progress bar instead of the wide per-source table.
 *
 * Bound to the MANUAL partition: this strip sits on Swipe, where the Run button
 * is, and a scheduled run gets its own surface on the Runs tab rather than
 * interrupting triage here.
 */

import { subscribeToPipelineProgress } from "@client/lib/progress-stream";
import type { PipelineProgressEvent } from "@shared/types";
import { Loader2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { computePercentage, stepLabels } from "./PipelineRunBanner";

const TERMINAL_STEPS: ReadonlySet<PipelineProgressEvent["step"]> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

interface PipelineProgressStripProps {
  isRunning: boolean;
}

export const PipelineProgressStrip: React.FC<PipelineProgressStripProps> = ({
  isRunning,
}) => {
  const [progress, setProgress] = useState<PipelineProgressEvent | null>(null);

  useEffect(() => {
    if (!isRunning) {
      setProgress(null);
      return;
    }
    return subscribeToPipelineProgress({
      trigger: "manual",
      onEvent: (payload) => {
        // An UNTAGGED terminal describes a run that is over, so it cannot be
        // the run this strip was mounted for. It is what the shared stream
        // replays on subscribe — the previous run's last broadcast, since
        // `resetProgress` notifies nobody — and rendering it would greet every
        // press of Run with the last run's "Complete" at 100%. A TAGGED one is
        // a single profile of a chain finishing, which the chain outlives.
        if (TERMINAL_STEPS.has(payload.step) && payload.profileRun == null) {
          return;
        }
        setProgress(payload);
      },
    });
  }, [isRunning]);

  if (!isRunning) return null;

  const profileRun = progress?.profileRun ?? null;
  const percentage = progress ? computePercentage(progress) : 0;
  const message = progress?.message ?? "Starting pipeline…";
  // Mid-chain, a profile's own terminal step would read "Complete" here while
  // the chain keeps going; the chain is only done once the events stop being
  // tagged, so fall back to the running label until then.
  const rawStep = progress?.step ?? "crawling";
  const step = profileRun && rawStep === "completed" ? "crawling" : rawStep;

  return (
    <div className="border-b bg-background/80 px-4 py-2">
      <div className="flex items-center gap-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="shrink-0 font-medium">{stepLabels[step]}</span>
        {profileRun && (
          <span className="shrink-0 text-primary">
            {profileRun.index}/{profileRun.total}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {message}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {Math.round(percentage)}%
        </span>
      </div>
      <Progress value={percentage} className="mt-1.5 h-1" />
    </div>
  );
};
