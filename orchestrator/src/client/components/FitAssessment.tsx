import type { Job } from "@shared/types.js";
import { Sparkles } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/utils";

interface FitAssessmentProps {
  job: Job;
  className?: string;
}

/**
 * What ran the assessment: the model, plus the reasoning effort when the
 * provider has one. Null for rows scored before either was recorded — the
 * header then reads exactly as it always did.
 */
function scoredByLabel(job: Job): string | null {
  if (!job.suitabilityModel) return null;
  return job.suitabilityEffort
    ? `${job.suitabilityModel} (${job.suitabilityEffort})`
    : job.suitabilityModel;
}

export const FitAssessment: React.FC<FitAssessmentProps> = ({
  job,
  className,
}) => {
  if (!job.suitabilityReason) return null;

  const scoredBy = scoredByLabel(job);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-primary/70 mb-1.5 flex items-center justify-between gap-2">
          <span className="flex shrink-0 items-center gap-1.5">
            <Sparkles className="h-3 w-3" />
            Fit Assessment
          </span>
          {scoredBy ? (
            <span
              className="truncate font-mono text-[10px] normal-case tracking-normal text-primary/60"
              title={`Scored by ${scoredBy}`}
            >
              {scoredBy}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-foreground/90 leading-relaxed font-medium">
          {job.suitabilityReason}
        </p>
      </div>
    </div>
  );
};
