import { tailoringFailureSummary } from "@shared/tailoring-failure";
import type { JobListItem } from "@shared/types.js";
import { cn } from "@/lib/utils";
import { CompanyNameButton } from "./CompanyNameButton";
import {
  defaultStatusToken,
  LIVE_CLOSED_CHIP_CLASS,
  LIVE_EASY_APPLY_CHIP_CLASS,
  outcomeLabel,
  showsAppliedBadge,
  showsAppliedDate,
  showsEasyApplyChip,
  statusTokens,
} from "./constants";
import { JobCategoryBadge } from "./JobCategoryBadge";
import { appliedBadgeTitle, dateValue, formatCheckedAge } from "./utils";

interface JobRowContentProps {
  job: JobListItem;
  isSelected?: boolean;
  showStatusDot?: boolean;
  statusDotClassName?: string;
  className?: string;
  staleThresholdDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const daysSince = (value: number, now: number) =>
  Math.max(0, Math.floor((now - value) / DAY_MS));

/**
 * The row's one date pill, most useful measure first. On a row whose status
 * already says it was applied to, that is the application date — see
 * `showsAppliedDate`; everywhere else it is the posting date, with the
 * discovery date as the fallback for a posting that never carried one.
 */
function formatAge(
  job: JobListItem,
  now: number,
): { label: string; days: number; title?: string } | null {
  const applied = showsAppliedDate(job) ? dateValue(job.appliedAt) : null;
  // A stamp that will not parse falls through to the posting date rather than
  // blanking the pill.
  if (applied != null) {
    const days = daysSince(applied, now);
    return {
      label: `Applied ${days}d`,
      days,
      // The badge that normally carries the exact date is suppressed on these
      // rows, so the pill is the only place left to hang it.
      title: appliedBadgeTitle(job.appliedAt),
    };
  }
  const posted = dateValue(job.datePosted);
  if (posted != null) {
    const days = daysSince(posted, now);
    return { label: `Posted ${days}d`, days };
  }
  const found = dateValue(job.discoveredAt);
  if (found != null) {
    const days = daysSince(found, now);
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
  const wasApplied = showsAppliedBadge(job);
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
                title={age.title}
              >
                {age.label}
              </span>
            )}
            {repostCount > 0 && (
              <span
                className="rounded border border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-warn))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-warn))] px-1.5 py-px text-[10px] font-medium text-amber-200 tabular-nums"
                title={`Repost #${repostCount}`}
              >
                Reposted {repostCount > 9 ? "9+" : repostCount}×
              </span>
            )}
            {job.tailoringFailureReason && (
              <span
                className="rounded border border-[color:color-mix(in_oklab,var(--badge-base)_70%,var(--badge-bad))] bg-[color-mix(in_oklab,var(--badge-base)_90%,var(--badge-bad))] px-1.5 py-px text-[10px] font-medium text-rose-200"
                title={tailoringFailureSummary(job.tailoringFailureReason)}
              >
                Tailor failed
              </span>
            )}
            {job.salary?.trim() && (
              <span className="truncate">{job.salary}</span>
            )}
          </div>
        )}
        {job.liveStatusCheckedAt && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {job.liveClosed ? (
              <span className={LIVE_CLOSED_CHIP_CLASS}>
                No longer accepting applications
              </span>
            ) : (
              // A closed posting's applicant caption is reset by LinkedIn, so
              // the server stores null for it — this branch is open jobs only.
              <>
                <span className="truncate">
                  {job.liveApplicants ?? "Accepting applications"}
                </span>
                {showsEasyApplyChip(job) && (
                  <span className={LIVE_EASY_APPLY_CHIP_CLASS}>Easy Apply</span>
                )}
              </>
            )}
            <span
              className="text-muted-foreground/70"
              title={job.liveStatusCheckedAt}
            >
              {formatCheckedAge(job.liveStatusCheckedAt, Date.now())}
            </span>
          </div>
        )}
      </div>

      {(category ||
        closureReason ||
        isSkipped ||
        wasApplied ||
        sourceLabel) && (
        <div className="max-w-[11rem] shrink-0 text-right">
          {(category || closureReason || isSkipped || wasApplied) && (
            <div className="flex flex-wrap items-center justify-end gap-1">
              {category && <JobCategoryBadge category={category} />}
              {closureReason && (
                <span className="rounded-full border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-bad))] bg-[color-mix(in_oklab,var(--badge-base)_85%,var(--badge-bad))] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-300">
                  {closureReason}
                </span>
              )}
              {isSkipped && (
                <span className="rounded-full border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-warn))] bg-[color-mix(in_oklab,var(--badge-base)_85%,var(--badge-warn))] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                  Skipped
                </span>
              )}
              {wasApplied && (
                <span
                  className="rounded-full border border-[color:color-mix(in_oklab,var(--badge-base)_60%,var(--badge-teal))] bg-[color-mix(in_oklab,var(--badge-base)_85%,var(--badge-teal))] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal-300"
                  title={appliedBadgeTitle(job.appliedAt)}
                >
                  Applied
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
