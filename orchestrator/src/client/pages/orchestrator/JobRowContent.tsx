import type { JobListItem, SuitabilityCategory } from "@shared/types.js";
import { cn } from "@/lib/utils";
import { CompanyNameButton } from "./CompanyNameButton";
import { defaultStatusToken, outcomeLabel, statusTokens } from "./constants";

interface JobRowContentProps {
  job: JobListItem;
  isSelected?: boolean;
  showStatusDot?: boolean;
  statusDotClassName?: string;
  className?: string;
  staleThresholdDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const CATEGORY_PILL_CLASS: Record<SuitabilityCategory, string> = {
  very_good_fit:
    "bg-status-good/15 text-status-good-text border border-status-good/30",
  good_fit:
    "bg-status-info/10 text-status-info-text border border-status-info/30",
  bad_fit: "bg-muted/40 text-muted-foreground border border-border/60",
};

const CATEGORY_PILL_LABEL: Record<SuitabilityCategory, string> = {
  very_good_fit: "Very good",
  good_fit: "Good",
  bad_fit: "Bad",
};

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  // jobspy stores `date_posted` as a Unix-ms numeric string (e.g.
  // "1777075200000") rather than ISO; coerce numeric-only strings.
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAge(
  job: JobListItem,
  now: number,
): { label: string; days: number } | null {
  const posted = parseDate(job.datePosted);
  if (posted != null) {
    const days = Math.max(0, Math.floor((now - posted) / DAY_MS));
    return { label: `Posted ${days}d`, days };
  }
  const found = parseDate(job.discoveredAt);
  if (found != null) {
    const days = Math.max(0, Math.floor((now - found) / DAY_MS));
    return { label: `Found ${days}d`, days };
  }
  return null;
}

export const JobRowContent = ({
  job,
  isSelected = false,
  showStatusDot = true,
  statusDotClassName,
  className,
  staleThresholdDays,
}: JobRowContentProps) => {
  const category = job.suitabilityCategory ?? null;
  const closureReason = job.outcome ? outcomeLabel[job.outcome] : null;
  const isSkipped = job.status === "skipped";
  const sourceLabel = job.sourceLabel ?? job.source;
  const statusToken = statusTokens[job.status] ?? defaultStatusToken;
  const age = formatAge(job, Date.now());
  const isStale =
    job.status === "discovered" &&
    age != null &&
    typeof staleThresholdDays === "number" &&
    staleThresholdDays > 0 &&
    age.days >= staleThresholdDays;
  const repostCount = job.repostCount ?? 0;

  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-3", className)}>
      <span
        className={cn(
          "h-2 w-2 rounded-full shrink-0",
          statusToken.dot,
          !isSelected && "opacity-70",
          statusDotClassName,
          !showStatusDot && "hidden",
        )}
        title={statusToken.label}
      />

      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-sm leading-tight",
            isSelected ? "font-semibold" : "font-medium",
            isStale && "text-muted-foreground",
          )}
        >
          {job.title}
        </div>
        <div className="truncate text-xs text-muted-foreground mt-0.5">
          <CompanyNameButton
            employer={job.employer}
            className="align-baseline"
          />
          {job.location && (
            <span className="before:content-['_in_']">{job.location}</span>
          )}
        </div>
        {(age ||
          repostCount > 0 ||
          job.salary?.trim() ||
          job.tailoringFailureReason) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {age && (
              <span
                className={cn(
                  "tabular-nums",
                  isStale && "text-muted-foreground/70",
                )}
              >
                {age.label}
              </span>
            )}
            {repostCount > 0 && (
              <span
                className="rounded border border-status-warn/30 bg-status-warn/10 px-1.5 py-px text-[10px] font-medium text-status-warn-text tabular-nums"
                title={`Repost #${repostCount}`}
              >
                Reposted {repostCount > 9 ? "9+" : repostCount}×
              </span>
            )}
            {job.tailoringFailureReason && (
              <span
                className="rounded border border-status-bad/30 bg-status-bad/10 px-1.5 py-px text-[10px] font-medium text-status-bad-text"
                title={job.tailoringFailureReason}
              >
                Tailor failed
              </span>
            )}
            {job.salary?.trim() && (
              <span className="truncate">{job.salary}</span>
            )}
          </div>
        )}
      </div>

      {(category || closureReason || isSkipped || sourceLabel) && (
        <div className="shrink-0 text-right">
          {(category || closureReason || isSkipped) && (
            <div className="flex items-center justify-end gap-1">
              {category && (
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    CATEGORY_PILL_CLASS[category],
                  )}
                >
                  {CATEGORY_PILL_LABEL[category]}
                </span>
              )}
              {closureReason && (
                <span className="rounded-full border border-status-bad/40 bg-status-bad/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-bad-text">
                  {closureReason}
                </span>
              )}
              {isSkipped && (
                <span className="rounded-full border border-status-warn/40 bg-status-warn/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-warn-text">
                  Skipped
                </span>
              )}
            </div>
          )}
          {sourceLabel && (
            <div
              className="mt-0.5 max-w-[10rem] truncate text-[10px] text-muted-foreground"
              title={sourceLabel}
            >
              {sourceLabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
