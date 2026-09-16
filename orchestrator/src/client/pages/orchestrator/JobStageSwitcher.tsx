import * as api from "@client/api";
import { toast } from "@client/lib/toast";
import { restoreJobStates, snapshotJob } from "@client/lib/undo";
import type { Job, JobOutcome, JobStatus } from "@shared/types.js";
import { Check, ChevronDown } from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isEverApplied, statusTokens } from "./constants";
import { useUndo } from "./useUndoController";

/**
 * Every part of the pipeline a job can be moved TO, in pipeline order — one
 * entry per destination the Manage tabs can show. The control is deliberately
 * unconditional: it renders whatever the row's current status is, so no row can
 * become unreachable by sitting somewhere the rest of the UI has no INTENTIONAL
 * action for.
 *
 * The edge case it exists for: a clean `processing` row (a tailor that never
 * reported back) is refused by the bulk skip guard and by delete, and its only
 * detail view is a spinner. What could move it was a server restart — boot
 * reconciliation stamps such rows "Tailoring interrupted (server restart)",
 * which turns them into retryable failures — or losing a duplicate review,
 * since `mark_duplicated` accepts `processing` and ranks it BELOW a tailored
 * twin. Neither is something a user can aim.
 *
 * `processing` and `selected` are the two statuses NOTHING can move a job to.
 * (`closed` is absent from this list too, but it is reachable — through
 * `CLOSE_REASONS` below, on a row that was actually applied to.) Setting
 * `processing` by hand launches no tailor, stamps
 * `processed_at` (which attributes the row to a pipeline run) and leaves boot
 * reconciliation free to brand it interrupted though nothing ran; `selected`
 * is retired (`shared/types/jobs.ts`) and folds back to `discovered` at every
 * boot. Both remain valid CURRENT statuses — `stageLabel` falls through to
 * `statusTokens` to name them on the trigger.
 */
const STAGES: ReadonlyArray<{ status: JobStatus; label: string }> = [
  { status: "discovered", label: "Inbox" },
  { status: "ready", label: "Tailoring" },
  { status: "applied", label: "Live" },
  { status: "in_progress", label: "Interviewing" },
  { status: "backlog", label: "Backlog" },
  { status: "stale", label: "Stale" },
  { status: "skipped", label: "Skipped" },
];

/**
 * Closing is a stage move that carries a reason, so the four outcomes are the
 * menu's second group rather than one "Closed" item — the same list, in the
 * same words, as `MarkClosedPopover`. `duplicated` is absent from both: it
 * belongs to the duplicate-review flow, which writes it with the group it
 * resolved.
 *
 * A `closed` row with no outcome renders no chip and falls into the residual
 * `moved_on` bucket of `getApplicationStats`, so the reason is asked for rather
 * than defaulted.
 *
 * The group is offered ONLY on a row carrying the permanent applied mark —
 * `isEverApplied`, the same predicate behind the Filters panel's "Ever applied"
 * and the search's `@ever-applied` lock. It is deliberately NOT the bulk
 * `mark_closed` population, which is a STATUS test (`applied`/`in_progress`)
 * and so disagrees at both edges: a `backlog` row carrying the mark gets these
 * four here and would be refused there, and a legacy `applied` row the boot
 * backfill could not stamp is accepted there and gets only Skipped here.
 * Two reasons for the gate, and the second is not cosmetic: an outcome
 * describes how an APPLICATION ended, so a job nobody applied to belongs in
 * Skipped (which sits on the same Closed tab and IS offered from everywhere);
 * and `closed` + one of rejected/withdrawn/ghosted
 * + a null `applied_at` is exactly the row shape the boot backfill in
 * `db/migrate.ts` treats as a legacy application and stamps `applied_at` onto.
 * That backfill documents itself as closed-population-and-therefore-idempotent.
 * Offering these four from an Inbox row would reopen it, and every such close
 * would come back next boot counted as an application AND as a rejection.
 */
const CLOSE_REASONS: ReadonlyArray<{ outcome: JobOutcome; label: string }> = [
  { outcome: "rejected", label: "Rejected" },
  { outcome: "withdrawn", label: "Withdrew" },
  { outcome: "ghosted", label: "Ghosted" },
  { outcome: "other", label: "Other" },
];

const CLOSED_LABEL = statusTokens.closed.label;

/**
 * What the trigger calls the row's current status. Total over `JobStatus`:
 * `statusTokens` is a `Record<JobStatus, …>`, so the three statuses `STAGES`
 * does not carry — `processing`, `selected`, `closed` — still get a name.
 * `STAGES` is consulted FIRST because three of its seven labels deliberately
 * differ from the status names in `statusTokens`: they are the TAB names, so
 * `discovered`/`ready`/`applied` read "Inbox"/"Tailoring"/"Live" rather than
 * "Discovered"/"Ready"/"Applied". The other four agree with `statusTokens`
 * exactly, which is why the order only matters for those three.
 */
function stageLabel(status: JobStatus): string {
  return (
    STAGES.find((stage) => stage.status === status)?.label ??
    statusTokens[status].label
  );
}

interface JobStageSwitcherProps {
  job: Job;
  onJobUpdated: () => void | Promise<void>;
  onJobMoved?: (jobId: string) => void;
  className?: string;
}

export const JobStageSwitcher: React.FC<JobStageSwitcherProps> = ({
  job,
  onJobUpdated,
  onJobMoved,
  className,
}) => {
  const [isMoving, setIsMoving] = useState(false);
  const { pushUndo, undo } = useUndo();

  const applyMove = useCallback(
    async (action: string, patch: Partial<Job>) => {
      try {
        setIsMoving(true);
        const snap = snapshotJob(job);
        await api.updateJob(job.id, patch);
        // Everything EXCEPT a move off `processing` gets an undo entry.
        // `restoreJobStates` writes the captured status back verbatim with no
        // re-read, so undoing that particular move puts the row back at
        // `processing` with no tailor behind it and no failure reason — the
        // stuck state this control exists to escape, one click from the toast.
        // It would also re-stamp `processed_at` (a `updateJob` side effect the
        // snapshot does not carry and cannot reverse), re-attributing the row
        // to a pipeline run. The move stays reversible by hand: the switcher
        // is still there, offering every stage.
        if (job.status !== "processing") {
          pushUndo({
            label: action,
            restore: async () => {
              await restoreJobStates([snap]);
            },
          });
        }
        onJobMoved?.(job.id);
        await onJobUpdated();
        toast.success(action, {
          ...(job.status !== "processing"
            ? { action: { label: "Undo", onClick: () => undo() } }
            : {}),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to move job";
        toast.error(message);
      } finally {
        setIsMoving(false);
      }
    },
    [job, onJobMoved, onJobUpdated, pushUndo, undo],
  );

  // Leaving Closed clears the close-out, which is what the bulk `reopen` action
  // writes. Without it a row moved Closed -> Live keeps its outcome and
  // `closedAt`, so the detail header renders a "Rejected" chip on a live
  // application and `getApplicationStats` still counts it as rejected. The same
  // clear is right for a row whose outcome was written by `PATCH /:id/outcome`
  // with no status change — a state that route makes reachable.
  const handleMove = useCallback(
    (status: JobStatus, label: string) => {
      if (status === job.status) return;
      void applyMove(`Moved to ${label}`, {
        status,
        outcome: null,
        closedAt: null,
      });
    },
    [applyMove, job.status],
  );

  // Closing STAMPS the close date; correcting the reason on a row that is
  // already closed must not move it. The menu offers both under one group and
  // the header says which it is doing, so without this a "Change reason" on a
  // job closed three months ago would re-date it to today — moving the row
  // under the Closed date filter and corrupting the time-to-close the
  // application stats derive from `closed_at - applied_at`. No earlier surface
  // could change a closed row's reason, so there is no precedent to inherit.
  const handleClose = useCallback(
    (outcome: JobOutcome, label: string) => {
      const isReasonChange = job.status === "closed";
      void applyMove(
        isReasonChange
          ? `Reason changed to ${label}`
          : `Moved to ${CLOSED_LABEL}`,
        {
          status: "closed",
          outcome,
          closedAt: isReasonChange
            ? (job.closedAt ?? Math.floor(Date.now() / 1000))
            : Math.floor(Date.now() / 1000),
        },
      );
    },
    [applyMove, job.status, job.closedAt],
  );

  const offersCloseReasons = isEverApplied(job);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn("h-8 gap-1.5 text-xs", className)}
          disabled={isMoving}
        >
          Stage: {stageLabel(job.status)}
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
        {STAGES.map((stage) => {
          const isCurrent = stage.status === job.status;
          // Tailoring re-enters the ReadyPanel, whose preview reads the
          // rendered CV PDF. A row without one is still allowed through —
          // moving freely is the whole point of this control — but it is
          // labelled, because the panel is the one destination built for a
          // precondition the row may not meet: the preview shows its "No PDF
          // rendered yet" state, and Download CV / View PDF / the `d` shortcut
          // all point at a file that 404s. What repairs it is Generate (the
          // bulk action, or the one in the CV tab), which runs summarizeJob
          // and pins a CV document first. NOT the panel's own "Regenerate
          // PDF": that endpoint hard-fails with "Job is not pinned to a CV
          // document" on exactly the rows this annotation marks.
          const missingPdf = stage.status === "ready" && !job.pdfPath;
          return (
            <DropdownMenuItem
              key={stage.status}
              disabled={isCurrent}
              onSelect={() => handleMove(stage.status, stage.label)}
            >
              {isCurrent ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <span className="mr-2 inline-block h-4 w-4" />
              )}
              {stage.label}
              {missingPdf && !isCurrent ? (
                <span className="ml-auto pl-2 text-[10px] text-muted-foreground">
                  no PDF
                </span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
        {offersCloseReasons ? <DropdownMenuSeparator /> : null}
        {offersCloseReasons ? (
          <DropdownMenuLabel>
            {job.status === "closed" ? "Change reason" : "Close with reason"}
          </DropdownMenuLabel>
        ) : null}
        {(offersCloseReasons ? CLOSE_REASONS : []).map((reason) => {
          const isCurrent =
            job.status === "closed" && job.outcome === reason.outcome;
          return (
            <DropdownMenuItem
              key={reason.outcome}
              disabled={isCurrent}
              onSelect={() => handleClose(reason.outcome, reason.label)}
            >
              {isCurrent ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <span className="mr-2 inline-block h-4 w-4" />
              )}
              {reason.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
