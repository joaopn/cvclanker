import { useSettings } from "@client/hooks/useSettings";
import type { Job } from "@shared/types.js";
import {
  AlertTriangle,
  Archive,
  Edit2,
  Loader2,
  RefreshCcw,
  Sparkles,
  XCircle,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { JobDescriptionMarkdown } from "@/client/components/JobDescriptionMarkdown";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { FitAssessment } from "..";
import { CompanyNameButton } from "../../pages/orchestrator/CompanyNameButton";
import { FitIndicator } from "../ScoreIndicator";
import { KbdHint } from "../KbdHint";
import { OpenJobListingButton } from "../OpenJobListingButton";
import { CollapsibleSection } from "./CollapsibleSection";
import { getRenderableJobDescription } from "./helpers";

interface DecideModeProps {
  job: Job;
  onTailor: () => void;
  onSkip: () => void;
  isSkipping: boolean;
  onRescore: () => void;
  isRescoring: boolean;
  onEditDetails: () => void;
  onMoveToBacklog: () => void;
  isMovingStatus: boolean;
}

export const DecideMode: React.FC<DecideModeProps> = ({
  job,
  onTailor,
  onSkip,
  isSkipping,
  onRescore,
  isRescoring,
  onEditDetails,
  onMoveToBacklog,
  isMovingStatus,
}) => {
  const [showDescription, setShowDescription] = useState(false);
  const jobLink = job.applicationLink || job.jobUrl;
  const { renderMarkdownInJobDescriptions } = useSettings();

  const description = useMemo(
    () => getRenderableJobDescription(job.jobDescription),
    [job.jobDescription],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="space-y-4 pb-4">
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
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
        </div>

        <FitAssessment job={job} />

        {job.tailoringFailureReason ? (
          <div className="rounded-md border border-status-bad/40 bg-status-bad/5 px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5 font-semibold text-status-bad-text">
              <AlertTriangle className="h-3.5 w-3.5" />
              Last tailoring attempt failed
            </div>
            <p className="mt-1 whitespace-pre-wrap text-status-bad-text/90">
              {job.tailoringFailureReason}
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-2.5 pt-2 sm:flex-row">
          {jobLink ? (
            <OpenJobListingButton
              href={jobLink}
              className="flex-1 h-11 text-sm sm:h-10 sm:text-xs"
            />
          ) : null}
          <Button
            variant="outline"
            size="default"
            onClick={onMoveToBacklog}
            disabled={isMovingStatus}
            className="flex-1 h-11 text-sm text-muted-foreground hover:text-foreground sm:h-10 sm:text-xs"
          >
            {isMovingStatus ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Archive className="mr-2 h-4 w-4" />
            )}
            Backlog
            <KbdHint shortcut="b" className="ml-1.5" />
          </Button>
          <Button
            variant="outline"
            size="default"
            onClick={onSkip}
            disabled={isSkipping}
            className="flex-1 h-11 text-sm text-muted-foreground hover:text-status-bad-text hover:border-status-bad/30 hover:bg-status-bad/5 sm:h-10 sm:text-xs"
          >
            {isSkipping ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <XCircle className="mr-2 h-4 w-4" />
            )}
            Skip Job
            <KbdHint shortcut="s" className="ml-1.5" />
          </Button>
          <Button
            size="default"
            onClick={onTailor}
            className="flex-1 h-11 text-sm bg-primary/90 hover:bg-primary sm:h-10 sm:text-xs shadow-sm"
          >
            <Sparkles className="mr-2 h-4 w-4" />
            Start Tailoring
            <KbdHint shortcut="r" className="ml-1.5" />
          </Button>
        </div>
      </div>

      <Separator className="opacity-40" />

      <div className="flex-1 py-6 space-y-6 overflow-y-auto">
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
      </div>

      <Separator className="opacity-40" />

      <div className="flex flex-col gap-2 pt-4 pb-2 sm:flex-row">
        <Button
          variant="ghost"
          size="sm"
          onClick={onEditDetails}
          className="flex-1 h-8 gap-2 text-xs text-muted-foreground hover:text-foreground justify-center"
        >
          <Edit2 className="h-3.5 w-3.5" />
          Edit details
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRescore}
          disabled={isRescoring}
          className="flex-1 h-8 gap-2 text-xs text-muted-foreground hover:text-foreground justify-center"
        >
          <RefreshCcw
            className={isRescoring ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
          />
          {isRescoring ? "Recalculating..." : "Recalculate match"}
        </Button>
      </div>
    </div>
  );
};
