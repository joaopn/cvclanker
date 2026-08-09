import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import { restoreJobStates, snapshotJob } from "@client/lib/undo";
import {
  type DuplicateJobGroup,
  type JobListItem,
  type JobStatus,
  SUITABILITY_CATEGORY_RANK,
} from "@shared/types";
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

function fitRank(job: JobListItem): number {
  return job.suitabilityCategory
    ? SUITABILITY_CATEGORY_RANK[job.suitabilityCategory]
    : -1;
}

// Preselected-keeper priority by pipeline position: Live (applied/in_progress)
// > Ready > Selected (selected/processing) > Inbox (discovered). Statuses not
// listed (backlog/stale/skipped/closed) rank lowest. Higher wins.
const STATUS_KEEPER_RANK: Partial<Record<JobStatus, number>> = {
  applied: 4,
  in_progress: 4,
  ready: 3,
  selected: 2,
  processing: 2,
  discovered: 1,
};

function statusKeeperRank(job: JobListItem): number {
  return STATUS_KEEPER_RANK[job.status] ?? 0;
}

// Default keeper: furthest along the pipeline first (Live > Ready > Selected >
// Inbox), then best fit, then newest posting, then newest discovered.
function chooseKeeper(jobs: JobListItem[]): string {
  const sorted = [...jobs].sort((a, b) => {
    const status = statusKeeperRank(b) - statusKeeperRank(a);
    if (status !== 0) return status;
    const fit = fitRank(b) - fitRank(a);
    if (fit !== 0) return fit;
    const posted =
      (parseDate(b.datePosted) ?? 0) - (parseDate(a.datePosted) ?? 0);
    if (posted !== 0) return posted;
    return (parseDate(b.discoveredAt) ?? 0) - (parseDate(a.discoveredAt) ?? 0);
  });
  return sorted[0]?.id ?? "";
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

  const handleSkip = () => setIndex((i) => i + 1);

  const handleCloseDuplicates = async () => {
    if (!group) return;
    const keeperId = keeperByKey[group.key];
    const losers = group.jobs.filter((job) => job.id !== keeperId);
    if (losers.length === 0) {
      setIndex((i) => i + 1);
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
        const label = `Marked ${okCount} duplicate${okCount === 1 ? "" : "s"}`;
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
      setIndex((i) => i + 1);
    } catch {
      toast.error("Failed to mark duplicates");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Review duplicates</DialogTitle>
          <DialogDescription>
            {done
              ? "All duplicate groups reviewed."
              : `Group ${index + 1} of ${total} · same title & company across sources. Keep one, close the rest.`}
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
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
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
              <Button onClick={handleCloseDuplicates} disabled={submitting}>
                {(() => {
                  const keeperId = keeperByKey[group.key];
                  const k = group.jobs.filter((j) => j.id !== keeperId).length;
                  return `Close ${k} as duplicate${k === 1 ? "" : "s"}`;
                })()}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
