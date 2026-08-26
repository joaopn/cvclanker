import type { JobOutcome } from "@shared/types.js";
import { AnimatePresence, motion } from "framer-motion";
import type React from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { FilterTab } from "./constants";
import { MarkClosedPopover } from "./MarkClosedPopover";

interface FloatingJobActionsBarProps {
  activeTab: FilterTab;
  selectedCount: number;
  canMoveSelected: boolean;
  canSkipSelected: boolean;
  canRescoreSelected: boolean;
  canClearScoreSelected: boolean;
  canRescrapeSelected: boolean;
  canMoveToBacklogSelected: boolean;
  canMoveToStaleSelected: boolean;
  canMoveToInboxSelected: boolean;
  canMarkClosedSelected: boolean;
  canReopenSelected: boolean;
  canDeleteSelected: boolean;
  canFetchLiveStatusSelected: boolean;
  canRetailorSelected: boolean;
  /**
   * How many of the selection Generate will actually act on — the tailored
   * rows plus the failed tailors it retries, i.e. everything on that tab but
   * the ones a tailor is running on right now. Its own prop because
   * `selectedCount` is
   * the WHOLE selection and this action dispatches a subset — spending numbers
   * quoted at the user have to be the ones that get spent.
   */
  retailorableCount: number;
  /** Name of the CV the re-tailor will run against, when known. */
  activeCvName: string | null;
  /** A pre-filter model is configured, so the screened variant is on offer. */
  hasScorerPrefilter: boolean;
  jobActionInFlight: boolean;
  onMoveToReady: () => void;
  onSkipSelected: () => void;
  onRescoreSelected: () => void;
  onScreenRescoreSelected: () => void;
  onClearScoreSelected: () => void;
  onRescrapeSelected: () => void;
  onMoveToBacklog: () => void;
  onMoveToStale: () => void;
  onMoveToInbox: () => void;
  onMarkClosed: (outcome: JobOutcome) => void;
  onReopen: () => void;
  onDelete: () => void;
  onFetchLiveStatus: () => void;
  onRetailor: () => void;
  onClear: () => void;
}

const jobOrJobs = (count: number) => (count === 1 ? "job" : "jobs");

export const FloatingJobActionsBar: React.FC<FloatingJobActionsBarProps> = ({
  activeTab,
  selectedCount,
  canMoveSelected,
  canSkipSelected,
  canRescoreSelected,
  canClearScoreSelected,
  canRescrapeSelected,
  canMoveToBacklogSelected,
  canMoveToStaleSelected,
  canMoveToInboxSelected,
  canMarkClosedSelected,
  canReopenSelected,
  canDeleteSelected,
  canFetchLiveStatusSelected,
  canRetailorSelected,
  retailorableCount,
  activeCvName,
  hasScorerPrefilter,
  jobActionInFlight,
  onMoveToReady,
  onSkipSelected,
  onRescoreSelected,
  onScreenRescoreSelected,
  onClearScoreSelected,
  onRescrapeSelected,
  onMoveToBacklog,
  onMoveToStale,
  onMoveToInbox,
  onMarkClosed,
  onReopen,
  onDelete,
  onFetchLiveStatus,
  onRetailor,
  onClear,
}) => {
  const buttonClass = "w-full sm:w-auto";

  // Re-fetch each selected job from its own URL and refresh its stored fields.
  // Available on the shelves (Inbox / Backlog / Stale) and All — the tabs where
  // a partial-scrape (e.g. a missing description) still matters for triage.
  const rescrapeButton = canRescrapeSelected ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className={buttonClass}
      disabled={jobActionInFlight}
      onClick={onRescrapeSelected}
    >
      Rescrape
    </Button>
  ) : null;

  // Recalculate the fit for the selection. Identical in every tab that offers
  // it, so it lives here rather than being spelled out four times.
  //
  // Two buttons once a pre-filter model is configured: the plain one always
  // goes to the scoring model — which is what makes a manual rescore a real
  // second opinion on anything the screen removed — and the screened one opts
  // this request into the cheap model first. Neither auto-skips.
  const rescoreButtons = canRescoreSelected ? (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={buttonClass}
        disabled={jobActionInFlight}
        onClick={onRescoreSelected}
        title="Score with the scoring model."
      >
        Recalculate match
      </Button>
      {hasScorerPrefilter && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={buttonClass}
          disabled={jobActionInFlight}
          onClick={onScreenRescoreSelected}
          title="Run the cheap pre-filter model first; only jobs it does not call a bad fit reach the scoring model."
        >
          Screen first
        </Button>
      )}
    </>
  ) : null;

  // Per-tab button rendering. Each branch returns the buttons that make
  // sense for the rows in that tab. Selection-state guards (`can*Selected`)
  // hide buttons that don't apply to the current selection (mixed-status
  // selections in All Jobs, etc.).
  const renderTabButtons = (): React.ReactNode => {
    switch (activeTab) {
      case "inbox":
        return (
          <>
            {canMoveSelected && (
              <Button
                type="button"
                size="sm"
                variant="default"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onMoveToReady}
              >
                Tailor {selectedCount} {jobOrJobs(selectedCount)}
              </Button>
            )}
            {canMoveToBacklogSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onMoveToBacklog}
              >
                Move to Backlog
              </Button>
            )}
            {rescoreButtons}
            {canClearScoreSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onClearScoreSelected}
              >
                Clear match
              </Button>
            )}
            {rescrapeButton}
            {canSkipSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onSkipSelected}
              >
                Skip
              </Button>
            )}
          </>
        );

      case "tailoring":
        return (
          <>
            {/* No Tailor button here. This tab holds only `processing` and
                `ready`, so `canMoveToReady`'s `every` is true ONLY when every
                selected row is a failed tailor — and in exactly that case
                Generate offers the same count, does the same thing, and asks
                for confirmation first. Two primary buttons quoting one number
                where the cheaper-looking one silently spends the same money is
                a trap, so Generate is the single entrance. Tailor still owns
                the untailored shelves on the other tabs. */}
            {canRetailorSelected && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    className={buttonClass}
                    disabled={jobActionInFlight}
                  >
                    Generate {retailorableCount} {jobOrJobs(retailorableCount)}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Re-tailor {retailorableCount}{" "}
                      {jobOrJobs(retailorableCount)}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      Each one is tailored from scratch against
                      {activeCvName ? ` "${activeCvName}"` : " the active CV"} —
                      one AI call and one LaTeX compile per job, replacing
                      whatever tailored text and PDF{" "}
                      {retailorableCount === 1 ? "it has" : "they have"} now.
                      Pick this after changing your CV template; a plain
                      re-render would keep the old wording. Rows show as
                      Processing until they finish, and anything that fails
                      stays here to retry. It cannot be cancelled once started.
                      {retailorableCount !== selectedCount &&
                        ` ${selectedCount - retailorableCount} of the ${selectedCount} selected ${
                          selectedCount - retailorableCount === 1
                            ? "is being tailored right now and will be skipped"
                            : "are being tailored right now and will be skipped"
                        }.`}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onRetailor}>
                      Generate {retailorableCount}{" "}
                      {jobOrJobs(retailorableCount)}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {rescoreButtons}
            {canSkipSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onSkipSelected}
              >
                Skip
              </Button>
            )}
          </>
        );

      case "live":
      case "interviewing":
        return (
          <>
            {canMarkClosedSelected && (
              <MarkClosedPopover
                onSelect={onMarkClosed}
                disabled={jobActionInFlight}
                trigger={
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    className={buttonClass}
                    disabled={jobActionInFlight}
                  >
                    Mark Closed
                  </Button>
                }
              />
            )}
          </>
        );

      case "backlog":
        return (
          <>
            {canMoveSelected && (
              <Button
                type="button"
                size="sm"
                variant="default"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onMoveToReady}
              >
                Tailor {selectedCount} {jobOrJobs(selectedCount)}
              </Button>
            )}
            {rescoreButtons}
            {rescrapeButton}
            {canSkipSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onSkipSelected}
              >
                Skip
              </Button>
            )}
          </>
        );

      case "stale":
        return (
          <>
            {canMoveToInboxSelected && (
              <Button
                type="button"
                size="sm"
                variant="default"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onMoveToInbox}
              >
                Move to Inbox
              </Button>
            )}
            {canMoveSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onMoveToReady}
              >
                Tailor {selectedCount} {jobOrJobs(selectedCount)}
              </Button>
            )}
            {canMoveToBacklogSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onMoveToBacklog}
              >
                Move to Backlog
              </Button>
            )}
            {rescrapeButton}
            {canSkipSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onSkipSelected}
              >
                Skip
              </Button>
            )}
          </>
        );

      case "closed":
        return (
          <>
            {canReopenSelected && (
              <Button
                type="button"
                size="sm"
                variant="default"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onReopen}
              >
                Reopen
              </Button>
            )}
          </>
        );

      default: // "all"
        return (
          <>
            {canMoveSelected && (
              <Button
                type="button"
                size="sm"
                variant="default"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onMoveToReady}
              >
                Tailor {selectedCount} {jobOrJobs(selectedCount)}
              </Button>
            )}
            {rescoreButtons}
            {rescrapeButton}
          </>
        );
    }
  };

  return (
    <AnimatePresence initial={false}>
      {selectedCount > 0 ? (
        <motion.div
          className="pointer-events-none fixed inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-3 sm:px-4"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          <div className="pointer-events-auto flex w-full max-w-md flex-col items-stretch gap-2 rounded-xl border border-border/70 bg-card/95 px-3 py-2 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-card/85 sm:w-auto sm:max-w-none sm:flex-row sm:flex-wrap sm:items-center">
            <div className="text-xs text-muted-foreground tabular-nums sm:mr-1">
              {selectedCount} selected
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
              {renderTabButtons()}
              {/* Deliberately outside the per-tab switch, like Delete: a live
                  LinkedIn check is useful wherever a row can be selected —
                  mostly for triaging what to tailor. Shown when at least one
                  selected job is a LinkedIn posting; the dispatcher acts on
                  that subset and skips the rest. */}
              {canFetchLiveStatusSelected && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={buttonClass}
                  disabled={jobActionInFlight}
                  onClick={onFetchLiveStatus}
                  title="Fetch each job's live status from LinkedIn: whether it still accepts applications, and how many people applied. Non-LinkedIn jobs in the selection are skipped."
                >
                  Live status
                </Button>
              )}
              {/* Deliberately outside the per-tab switch: deleting is valid
                  wherever a row can be selected, and every tab should offer the
                  same escape hatch. */}
              {canDeleteSelected && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className={buttonClass}
                      disabled={jobActionInFlight}
                    >
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Delete {selectedCount} {jobOrJobs(selectedCount)}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes {selectedCount === 1 ? "it" : "them"} from
                        the database for good, along with any generated PDFs,
                        notes and chat history. It cannot be undone, and the{" "}
                        {selectedCount === 1 ? "job" : "jobs"} will be
                        re-imported if a later scrape finds the same posting.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onDelete}>
                        Delete {selectedCount} {jobOrJobs(selectedCount)}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={buttonClass}
                onClick={onClear}
                disabled={jobActionInFlight}
              >
                Clear
              </Button>
            </div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};
