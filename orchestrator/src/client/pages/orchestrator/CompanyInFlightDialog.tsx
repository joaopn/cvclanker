/**
 * The box the duplicate-application guard shows: per employer in the selection,
 * the jobs already in flight there, so the user can decide before spending a
 * tailor on what may be the same opening under a second URL.
 */

import { tailoringFailureSummary } from "@shared/tailoring-failure";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { JobCategoryBadge } from "./JobCategoryBadge";
import { JobStatusBadge } from "./JobStatusBadge";
import { jobAgeLabel } from "./jobAgeLabel";
import type { TailorGuardPrompt } from "./useTailorCompanyGuard";

interface CompanyInFlightDialogProps {
  prompt: TailorGuardPrompt | null;
  onResolve: (ids: string[] | null) => void;
}

export const CompanyInFlightDialog = ({
  prompt,
  onResolve,
}: CompanyInFlightDialogProps) => {
  const groups = prompt?.groups ?? [];
  const allCount = prompt?.allIds.length ?? 0;
  const safeCount = prompt?.safeIds.length ?? 0;
  const blockedCount = allCount - safeCount;
  // Only worth offering when it differs from "Tailor anyway" — on an
  // all-conflicting selection it would dispatch nothing at all.
  const canSkipConflicts = safeCount > 0;

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        // Esc and the close button both mean "don't tailor" — the safe default
        // for a guard the user switched on deliberately.
        if (!open) onResolve(null);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          {/* Deliberately not "you're already applying": one of the four
              in-flight statuses is a FAILED tailor, where nothing was sent. */}
          <DialogTitle className="pr-6">
            {groups.length === 1
              ? `You already have work in flight at ${groups[0].employer}`
              : `You already have work in flight at ${groups.length} of these companies`}
          </DialogTitle>
          <DialogDescription>
            {blockedCount === 1
              ? "1 job you selected is"
              : `${blockedCount} jobs you selected are`}{" "}
            at a company with jobs already in tailoring, tailored, applied to or
            interviewing. The same opening is often posted under two URLs, and
            duplicate review cannot join those.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-2 max-h-[50vh] overflow-y-auto px-2">
          <ul className="flex flex-col gap-4 py-1">
            {groups.map((group) => (
              <li key={group.employer}>
                <p className="text-sm font-medium">
                  {group.employer}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    · {group.candidates.length} selected ·{" "}
                    {group.inFlight.length} already in flight
                  </span>
                </p>
                <ul className="mt-1 flex flex-col gap-1">
                  {group.inFlight.map((job) => {
                    const age = jobAgeLabel(job);
                    // The status badge alone cannot separate a running tailor
                    // from a failed one — both read "Processing" — and a failed
                    // tailor sent no application. This line is what tells them
                    // apart, so it is load-bearing here, not decoration.
                    const failure = job.tailoringFailureReason
                      ? tailoringFailureSummary(job.tailoringFailureReason)
                      : null;
                    return (
                      <li
                        key={job.id}
                        className="flex items-start justify-between gap-3 rounded-md border border-border/60 px-2 py-2"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">
                            {job.title}
                          </span>
                          {(age || job.location) && (
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {[age, job.location].filter(Boolean).join(" · ")}
                            </span>
                          )}
                          {failure && (
                            <span
                              className="mt-0.5 block truncate text-xs text-status-bad-text/80"
                              title={failure}
                            >
                              Tailor failed: {failure}
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {job.suitabilityCategory && (
                            <JobCategoryBadge
                              category={job.suitabilityCategory}
                            />
                          )}
                          <JobStatusBadge status={job.status} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button variant="ghost" onClick={() => onResolve(null)}>
            Cancel
          </Button>
          {canSkipConflicts && (
            <Button
              variant="outline"
              onClick={() => onResolve(prompt?.safeIds ?? [])}
            >
              Tailor the other {safeCount}
            </Button>
          )}
          <Button onClick={() => onResolve(prompt?.allIds ?? [])}>
            Tailor anyway ({allCount})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
