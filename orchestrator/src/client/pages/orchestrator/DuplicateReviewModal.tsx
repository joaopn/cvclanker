import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import { restoreJobStates, snapshotJob } from "@client/lib/undo";
import { chooseKeeper, losersOf } from "@shared/duplicate-resolution";
import type { DuplicateJobGroup, JobListItem, JobStatus } from "@shared/types";
import type React from "react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { tabs } from "./constants";

// Map each triage status to the tab it lives under in Manage, so the reviewer
// can see where each copy currently sits. Derived from the canonical `tabs`
// list (excluding the catch-all "all" tab, which has no statuses).
const STATUS_TAB_LABEL: Partial<Record<JobStatus, string>> = Object.fromEntries(
  tabs.flatMap((tab) => tab.statuses.map((status) => [status, tab.label])),
);

interface DuplicateReviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: DuplicateJobGroup[];
  // Refresh the duplicate list + the job list after a resolution.
  onResolved: () => void;
  pushUndo: (entry: { label: string; restore: () => Promise<void> }) => void;
  // The `maxBulkActionJobs` setting. "Close all" is one bulk action, so a big
  // backlog of duplicates can exceed it; the plan below batches rather than
  // letting the server reject the whole thing.
  maxBulkActionJobs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAge(job: JobListItem): string | null {
  const now = Date.now();
  const posted = parseDate(job.datePosted);
  if (posted != null) {
    return `Posted ${Math.max(0, Math.floor((now - posted) / DAY_MS))}d`;
  }
  const found = parseDate(job.discoveredAt);
  if (found != null) {
    return `Found ${Math.max(0, Math.floor((now - found) / DAY_MS))}d`;
  }
  return null;
}

interface CloseAllPlan {
  losers: JobListItem[];
  /** Leading groups this batch covers — how far the wizard advances. */
  groupCount: number;
  /** Groups the run could cover if the cap allowed; the label's denominator. */
  runLength: number;
  /** True when the cap held groups back, so the button has to run again. */
  capped: boolean;
}

/**
 * What one "close all" press would do: the CONTIGUOUS run of sweepable groups
 * starting at the current one, taken whole and in order until the cap would be
 * breached — splitting a group across batches would leave copies behind that no
 * longer read as duplicates.
 *
 * The run STOPS at the first group whose rows disagree about the job title.
 * Two reasons, and the second is the one that bit: such a group needs a human
 * decision, so sweeping past it would bury it; and because the wizard advances
 * by the number of groups covered, sweeping a non-contiguous set would land the
 * user on a group whose copies this press already closed — a screen showing
 * stale rows whose buttons then fail against the server's status guard.
 *
 * The first group of the run is always taken, so the button is never a no-op
 * when it is shown; a single group bigger than the cap is left for the server
 * to refuse, exactly as the per-group button would. A run of zero (the current
 * group needs review) is legitimate — the caller hides the button.
 */
function planCloseAll(
  groups: DuplicateJobGroup[],
  keeperByKey: Record<string, string>,
  maxBulkActionJobs: number,
): CloseAllPlan {
  const runEnd = groups.findIndex((candidate) => !candidate.bulkSafe);
  const run = runEnd === -1 ? groups : groups.slice(0, runEnd);

  const losers: JobListItem[] = [];
  let groupCount = 0;
  for (const group of run) {
    const next = losersOf(group, keeperByKey);
    if (groupCount > 0 && losers.length + next.length > maxBulkActionJobs) {
      break;
    }
    losers.push(...next);
    groupCount += 1;
  }
  return {
    losers,
    groupCount,
    runLength: run.length,
    capped: groupCount < run.length,
  };
}

const FIT_LABEL: Record<string, string> = {
  great_fit: "Great fit",
  very_good_fit: "Very good fit",
  good_fit: "Good fit",
  bad_fit: "Bad fit",
};

export const DuplicateReviewModal: React.FC<DuplicateReviewModalProps> = ({
  open,
  onOpenChange,
  groups,
  onResolved,
  pushUndo,
  maxBulkActionJobs,
}) => {
  // Snapshot the groups when the modal opens so the wizard is stable while the
  // job list refetches underneath; the parent refetches on close.
  const [localGroups, setLocalGroups] = useState<DuplicateJobGroup[]>([]);
  const [index, setIndex] = useState(0);
  const [keeperByKey, setKeeperByKey] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Snapshot only on the open transition, not on every `groups` change, so the
  // in-progress wizard stays stable while the list refetches underneath.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional open-only snapshot
  useEffect(() => {
    if (!open) return;
    setLocalGroups(groups);
    setIndex(0);
    const defaults: Record<string, string> = {};
    for (const group of groups) {
      defaults[group.key] = chooseKeeper(group.jobs);
    }
    setKeeperByKey(defaults);
  }, [open]);

  const total = localGroups.length;
  const group = localGroups[index] ?? null;
  const done = index >= total;

  const remainingGroups = localGroups.slice(index);
  const closeAllPlan = planCloseAll(
    remainingGroups,
    keeperByKey,
    maxBulkActionJobs,
  );

  const handleSkip = () => setIndex((i) => i + 1);

  /**
   * Close one batch of losers and advance past the groups it covered. Shared by
   * the per-group button and "close all" so both report, undo and advance
   * identically — only the size of the batch differs.
   */
  const closeLosers = async (
    losers: JobListItem[],
    buildLabel: (okCount: number) => string,
    advanceBy: number,
  ) => {
    if (losers.length === 0) {
      setIndex((i) => i + advanceBy);
      return;
    }
    const snapshots = losers.map(snapshotJob);
    const jobIds = losers.map((job) => job.id);

    setSubmitting(true);
    try {
      const response = await api.runJobAction({
        action: "mark_duplicated",
        jobIds,
      });
      const okCount = response.results.filter((r) => r.ok).length;
      const failCount = response.results.length - okCount;

      if (okCount > 0) {
        const label = buildLabel(okCount);
        toast.success(label);
        pushUndo({
          label,
          restore: async () => {
            await restoreJobStates(snapshots);
            onResolved();
          },
        });
      }
      if (failCount > 0) {
        toast.error(
          `Couldn't close ${failCount} job${failCount === 1 ? "" : "s"}`,
        );
      }
      onResolved();
      setIndex((i) => i + advanceBy);
    } catch {
      toast.error("Failed to mark duplicates");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCloseDuplicates = async () => {
    if (!group) return;
    await closeLosers(
      losersOf(group, keeperByKey),
      (n) => `Marked ${n} duplicate${n === 1 ? "" : "s"}`,
      1,
    );
  };

  const handleCloseAll = async () => {
    const { losers, groupCount } = closeAllPlan;
    if (groupCount === 0) return;
    await closeLosers(
      losers,
      (n) =>
        `Marked ${n} duplicate${n === 1 ? "" : "s"} across ${groupCount} group${
          groupCount === 1 ? "" : "s"
        }`,
      groupCount,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review duplicates</DialogTitle>
          <DialogDescription>
            {done
              ? "All duplicate groups reviewed."
              : `Group ${index + 1} of ${total} · the job board lists these under one posting id. Keep one, close the rest.`}
          </DialogDescription>
        </DialogHeader>

        {done || !group ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Nothing left to review.
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-sm font-semibold">{group.title}</div>
              <div className="text-xs text-muted-foreground">
                {group.employer} · {group.jobs.length} copies
              </div>
              {!group.bulkSafe && (
                // Say why this one is not swept, where the decision is made.
                <div className="mt-1 text-xs text-status-warn-text">
                  These copies carry the same posting id but different job
                  titles — decide this group yourself; Close all stops here.
                </div>
              )}
            </div>

            <RadioGroup
              value={keeperByKey[group.key] ?? ""}
              onValueChange={(value) =>
                setKeeperByKey((prev) => ({ ...prev, [group.key]: value }))
              }
              className="gap-2"
            >
              {group.jobs.map((job) => {
                const isKeeper = keeperByKey[group.key] === job.id;
                const age = formatAge(job);
                return (
                  <label
                    key={job.id}
                    htmlFor={`dup-${job.id}`}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-md border p-2.5 text-sm transition-colors",
                      isKeeper
                        ? "border-status-good/40 bg-status-good/5"
                        : "border-border/50 hover:bg-muted/30",
                    )}
                  >
                    <RadioGroupItem value={job.id} id={`dup-${job.id}`} />
                    <div className="min-w-0 flex-1">
                      {!group.bulkSafe && (
                        // The group header shows only the FIRST row's title, so
                        // without this the screen asks the user to weigh a
                        // title disagreement it never shows them.
                        <div className="truncate font-medium">{job.title}</div>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="truncate text-muted-foreground">
                          {job.sourceLabel ?? job.source}
                        </span>
                        <Badge variant="secondary" className="font-normal">
                          {STATUS_TAB_LABEL[job.status] ?? job.status}
                        </Badge>
                        {isKeeper && (
                          <Badge
                            variant="outline"
                            className="border-status-good/40 text-status-good-text"
                          >
                            Keep
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        {job.suitabilityCategory && (
                          <span>{FIT_LABEL[job.suitabilityCategory]}</span>
                        )}
                        {age && <span className="tabular-nums">{age}</span>}
                        <a
                          href={job.jobUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Open
                        </a>
                      </div>
                    </div>
                  </label>
                );
              })}
            </RadioGroup>

            {closeAllPlan.runLength > 1 && (
              <p className="text-xs text-muted-foreground">
                Close all keeps the selected copy here and the best-ranked copy
                in each group it covers — furthest along the pipeline first,
                then best fit, then newest. It stops at the next group whose
                rows disagree about the job title, leaving that one to you.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {done || !group ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={handleSkip}
                disabled={submitting}
              >
                Skip group
              </Button>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {closeAllPlan.runLength > 1 && (
                  <Button
                    variant="outline"
                    onClick={handleCloseAll}
                    disabled={submitting}
                  >
                    {(() => {
                      const jobs = closeAllPlan.losers.length;
                      const suffix = `(${jobs} job${jobs === 1 ? "" : "s"})`;
                      const n = closeAllPlan.groupCount;
                      const groupWord = `group${n === 1 ? "" : "s"}`;
                      if (closeAllPlan.capped) {
                        return `Close ${n} of ${closeAllPlan.runLength} groups ${suffix}`;
                      }
                      // "all" would overclaim when the run stops early at a
                      // group that needs a decision — say "next" instead.
                      return closeAllPlan.runLength < remainingGroups.length
                        ? `Close next ${n} ${groupWord} ${suffix}`
                        : `Close all ${n} ${groupWord} ${suffix}`;
                    })()}
                  </Button>
                )}
                <Button onClick={handleCloseDuplicates} disabled={submitting}>
                  {(() => {
                    const k = losersOf(group, keeperByKey).length;
                    return `Close ${k} as duplicate${k === 1 ? "" : "s"}`;
                  })()}
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
