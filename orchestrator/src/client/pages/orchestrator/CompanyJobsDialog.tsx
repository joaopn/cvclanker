/**
 * Centered dialog listing every registered job from one company (employer),
 * across all statuses, with each job's fit classification, status + closure
 * reason. Clicking a row navigates to that job in Manage and closes the dialog.
 *
 * Skipped jobs can be hidden with a tickbox, rendered for any company that has
 * jobs — INCLUDING one with nothing skipped, where it is a no-op. It was first
 * gated on `skippedCount > 0`, which reads well as an invariant ("never hide a
 * row without the control that hid it") and measured badly: on the dev database
 * that put the control on a small minority of the companies reachable from the
 * Inbox, and it was reported as missing. A control in a fixed place that
 * sometimes does nothing beats one that is sometimes absent. The old invariant
 * survives this a fortiori, since rows and control now share one gate.
 *
 * `allJobs.length > 0` keeps it off an EMPTY dialog, where a filter above "No
 * jobs from this company." would suggest the emptiness was its doing. That
 * costs no reachability: a company opened by clicking one of its rows has a job
 * by construction. (An empty dialog is reachable — `CompanyNameButton` passes a
 * trimmed name and the server compares untrimmed.)
 *
 * The dialog outlives any single company (the `employer` prop is
 * what opens it), so the choice is a working-session preference rather than a
 * per-company one: it survives closing the dialog and switching tabs, but
 * App.tsx unmounts this page on a route change off /jobs, which resets it.
 */

import * as api from "@client/api";
import { queryKeys } from "@client/lib/queryKeys";
import { tailoringFailureSummary } from "@shared/tailoring-failure";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BlacklistCompanyMenu } from "./BlacklistCompanyMenu";
import { type FilterTab, outcomeLabel } from "./constants";
import { JobCategoryBadge } from "./JobCategoryBadge";
import { getFilterTab } from "./JobCommandBar.utils";
import { JobStatusBadge } from "./JobStatusBadge";
import { jobAgeLabel } from "./jobAgeLabel";

interface CompanyJobsDialogProps {
  employer: string | null;
  onClose: () => void;
  onSelectJob: (tab: FilterTab, jobId: string) => void;
}

export const CompanyJobsDialog = ({
  employer,
  onClose,
  onSelectJob,
}: CompanyJobsDialogProps) => {
  const [hideSkipped, setHideSkipped] = useState(false);

  const query = useQuery({
    queryKey: employer
      ? queryKeys.jobs.byCompany(employer)
      : queryKeys.jobs.byCompany(""),
    queryFn: () => api.getJobs({ employer: employer ?? undefined }),
    enabled: employer != null,
    staleTime: 15_000,
  });

  const allJobs = query.data?.jobs ?? [];
  const skippedCount = allJobs.filter((job) => job.status === "skipped").length;
  const jobs = hideSkipped
    ? allJobs.filter((job) => job.status !== "skipped")
    : allJobs;

  return (
    <Dialog
      open={employer != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="pr-6">
            {employer}
            {query.isSuccess && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                · {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
              </span>
            )}
          </DialogTitle>
          {query.isSuccess && allJobs.length > 0 && (
            <div className="flex items-center justify-center gap-1.5 sm:justify-start">
              <Checkbox
                id="company-jobs-hide-skipped"
                checked={hideSkipped}
                onCheckedChange={(checked) => setHideSkipped(checked === true)}
              />
              <label
                htmlFor="company-jobs-hide-skipped"
                className="cursor-pointer text-xs font-medium text-muted-foreground"
              >
                Hide skipped{skippedCount > 0 ? ` (${skippedCount})` : ""}
              </label>
            </div>
          )}
        </DialogHeader>

        <div className="-mx-2 max-h-[60vh] overflow-y-auto px-2">
          {query.isLoading && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Loading…
            </p>
          )}
          {query.isError && (
            <p className="py-6 text-center text-sm text-status-bad-text">
              Couldn't load jobs for this company.
            </p>
          )}
          {query.isSuccess && allJobs.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No jobs from this company.
            </p>
          )}
          {query.isSuccess && allJobs.length > 0 && jobs.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Every job from this company is skipped.
            </p>
          )}
          {query.isSuccess && jobs.length > 0 && (
            <ul className="flex flex-col gap-1 py-1">
              {jobs.map((job) => {
                const age = jobAgeLabel(job);
                const closureReason =
                  job.status === "closed" && job.outcome
                    ? outcomeLabel[job.outcome]
                    : null;
                return (
                  <li key={job.id}>
                    <button
                      type="button"
                      className="flex w-full items-start justify-between gap-3 rounded-md border border-transparent px-2 py-2 text-left hover:border-border hover:bg-muted/40 focus:border-border focus:outline-none"
                      onClick={() => {
                        onSelectJob(getFilterTab(job.status), job.id);
                        onClose();
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {job.title}
                        </span>
                        {(age || job.location) && (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {[age, job.location].filter(Boolean).join(" · ")}
                          </span>
                        )}
                        {job.tailoringFailureReason && (
                          <span
                            className="mt-0.5 block truncate text-xs text-status-bad-text/80"
                            title={tailoringFailureSummary(
                              job.tailoringFailureReason,
                            )}
                          >
                            Tailor failed:{" "}
                            {tailoringFailureSummary(
                              job.tailoringFailureReason,
                            )}
                          </span>
                        )}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="flex items-center gap-1">
                          {job.suitabilityCategory && (
                            <JobCategoryBadge
                              category={job.suitabilityCategory}
                            />
                          )}
                          <JobStatusBadge status={job.status} />
                        </span>
                        {closureReason && (
                          <span className="text-[10px] text-muted-foreground">
                            {closureReason}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {employer?.trim() ? (
          <DialogFooter className="sm:justify-start">
            <BlacklistCompanyMenu employer={employer.trim()} />
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
