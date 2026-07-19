import type { Job } from "@shared/types";
import { CircleAlert, CircleCheck } from "lucide-react";
import type React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type AtsCoverageBadgeProps = {
  job: Job;
};

/**
 * Reads `tailoringMatched` / `tailoringSkipped` from the job and renders a
 * compact "X/Y JD keywords surfaced" badge. Hovering reveals the skipped
 * keywords so the user can decide whether to expand the personal brief.
 */
export const AtsCoverageBadge: React.FC<AtsCoverageBadgeProps> = ({ job }) => {
  const matched = job.tailoringMatched ?? [];
  const skipped = job.tailoringSkipped ?? [];
  const total = matched.length + skipped.length;

  if (total === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
        <CircleAlert className="h-3.5 w-3.5" />
        <span>ATS coverage unavailable — re-tailor the job to populate.</span>
      </div>
    );
  }

  const ratio = matched.length / total;
  const dotClass =
    ratio >= 0.75
      ? "bg-status-good"
      : ratio >= 0.5
        ? "bg-status-warn"
        : "bg-status-bad";

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-1.5 text-xs">
            <span className={`inline-block h-2 w-2 rounded-full ${dotClass}`} />
            <span className="font-medium">
              {matched.length}/{total} JD keywords surfaced
            </span>
            {skipped.length > 0 ? (
              <span className="text-muted-foreground">
                · {skipped.length} skipped
              </span>
            ) : (
              <CircleCheck className="h-3.5 w-3.5 text-status-good-text" />
            )}
          </div>
        </TooltipTrigger>
        {skipped.length > 0 ? (
          <TooltipContent side="bottom" align="start" className="max-w-[320px]">
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-foreground">
                Skipped (no evidence in personal brief)
              </p>
              <ul className="flex flex-wrap gap-1">
                {skipped.map((keyword) => (
                  <li
                    key={keyword}
                    className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {keyword}
                  </li>
                ))}
              </ul>
            </div>
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  );
};
