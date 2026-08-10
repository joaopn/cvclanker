import type { JobOutcome } from "@shared/types.js";
import { AnimatePresence, motion } from "framer-motion";
import type React from "react";
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
  jobActionInFlight: boolean;
  onMoveToReady: () => void;
  onSkipSelected: () => void;
  onRescoreSelected: () => void;
  onClearScoreSelected: () => void;
  onRescrapeSelected: () => void;
  onMoveToBacklog: () => void;
  onMoveToStale: () => void;
  onMoveToInbox: () => void;
  onMarkClosed: (outcome: JobOutcome) => void;
  onReopen: () => void;
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
  jobActionInFlight,
  onMoveToReady,
  onSkipSelected,
  onRescoreSelected,
  onClearScoreSelected,
  onRescrapeSelected,
  onMoveToBacklog,
  onMoveToStale,
  onMoveToInbox,
  onMarkClosed,
  onReopen,
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
            {canRescoreSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onRescoreSelected}
              >
                Recalculate match
              </Button>
            )}
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
            {canRescoreSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onRescoreSelected}
              >
                Recalculate match
              </Button>
            )}
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
            {canRescoreSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onRescoreSelected}
              >
                Recalculate match
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
            {canRescoreSelected && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={buttonClass}
                disabled={jobActionInFlight}
                onClick={onRescoreSelected}
              >
                Recalculate match
              </Button>
            )}
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
