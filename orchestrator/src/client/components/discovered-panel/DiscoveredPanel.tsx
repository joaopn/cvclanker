import * as api from "@client/api";
import { useSkipJobMutation } from "@client/hooks/queries/useJobMutations";
import { useRescoreJob } from "@client/hooks/useRescoreJob";
import type { Job } from "@shared/types.js";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "@client/lib/toast";
import { JobDetailsEditDrawer } from "../JobDetailsEditDrawer";
import { DecideMode } from "./DecideMode";
import { EmptyState } from "./EmptyState";
import { ProcessingState } from "./ProcessingState";

interface DiscoveredPanelProps {
  job: Job | null;
  onJobUpdated: () => void | Promise<void>;
  onJobMoved: (jobId: string) => void;
  onTailoringDirtyChange?: (isDirty: boolean) => void;
}

export const DiscoveredPanel: React.FC<DiscoveredPanelProps> = ({
  job,
  onJobUpdated,
  onJobMoved,
  onTailoringDirtyChange,
}) => {
  const [isSkipping, setIsSkipping] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [isMovingStatus, setIsMovingStatus] = useState(false);
  const [isEditDetailsOpen, setIsEditDetailsOpen] = useState(false);
  const previousJobIdRef = useRef<string | null>(null);
  const skipJobMutation = useSkipJobMutation();
  const { isRescoring, rescoreJob } = useRescoreJob(onJobUpdated);

  useEffect(() => {
    const currentJobId = job?.id ?? null;
    if (previousJobIdRef.current === currentJobId) return;
    previousJobIdRef.current = currentJobId;
    setIsSkipping(false);
    setIsFinalizing(false);
    setIsEditDetailsOpen(false);
    onTailoringDirtyChange?.(false);
  }, [job?.id, onTailoringDirtyChange]);

  const handleSkip = async () => {
    if (!job) return;
    try {
      setIsSkipping(true);
      await skipJobMutation.mutateAsync(job.id);
      toast.message("Job skipped");
      onJobMoved(job.id);
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to skip job";
      toast.error(message);
    } finally {
      setIsSkipping(false);
    }
  };

  const handleFinalize = async () => {
    if (!job || isFinalizing) return;
    try {
      setIsFinalizing(true);
      await api.processJob(job.id);

      toast.success("Tailoring started", {
        description: "It'll appear in the Tailoring tab when ready.",
      });

      onJobMoved(job.id);
      await onJobUpdated();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to finalize job";
      toast.error(message);
    } finally {
      setIsFinalizing(false);
    }
  };

  const handleRescore = () => rescoreJob(job?.id);

  const flipStatus = async (
    status: "discovered" | "backlog",
    successLabel: string,
    failureLabel: string,
  ) => {
    if (!job || isMovingStatus) return;
    try {
      setIsMovingStatus(true);
      await api.updateJob(job.id, { status });
      toast.message(successLabel);
      onJobMoved(job.id);
      await onJobUpdated();
    } catch (error) {
      const message = error instanceof Error ? error.message : failureLabel;
      toast.error(message);
    } finally {
      setIsMovingStatus(false);
    }
  };

  const handleMoveToBacklog = () =>
    flipStatus("backlog", "Moved to Backlog", "Failed to move to Backlog");

  if (!job) {
    return <EmptyState />;
  }

  // A clean `processing` row is actively running → spinner. A failed one (a
  // reason is set) falls through to DecideMode, which shows the failure and the
  // Retry (Start Tailoring → move_to_ready) + Skip actions in place, rather than
  // a permanent spinner.
  if (job.status === "processing" && !job.tailoringFailureReason) {
    return <ProcessingState />;
  }

  return (
    <div className="h-full">
      <DecideMode
        job={job}
        onTailor={handleFinalize}
        onSkip={handleSkip}
        isSkipping={isSkipping}
        onRescore={handleRescore}
        isRescoring={isRescoring}
        onEditDetails={() => setIsEditDetailsOpen(true)}
        onMoveToBacklog={handleMoveToBacklog}
        isMovingStatus={isMovingStatus}
      />

      <JobDetailsEditDrawer
        open={isEditDetailsOpen}
        onOpenChange={setIsEditDetailsOpen}
        job={job}
        onJobUpdated={onJobUpdated}
      />
    </div>
  );
};

export default DiscoveredPanel;
