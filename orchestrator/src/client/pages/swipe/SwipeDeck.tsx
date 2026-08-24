/**
 * Composes the Swipe deck: the top draggable card (with a peek of the next
 * one behind), the action bar, the bottom filter sheet, and the loading /
 * empty / error states.
 */

import type { Profile } from "@shared/types.js";
import { Loader2, Play, RotateCcw } from "lucide-react";
import type React from "react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { collectProfileSearchTitles } from "../orchestrator/utils";
import { FitCountChips } from "./FitCountChips";
import { SwipeActionBar } from "./SwipeActionBar";
import { SwipeCard, SwipeCardContent, type SwipeCardHandle } from "./SwipeCard";
import { SwipeFilterSheet } from "./SwipeFilterSheet";
import {
  applySwipeFilters,
  EMPTY_SWIPE_FILTERS,
  effectiveSwipeFilters,
  hasActiveSwipeFilters,
  type SwipeFilterState,
} from "./swipeFilters";
import { useSwipeDeck } from "./useSwipeDeck";

interface SwipeDeckProps {
  pipelineTerminalEvent: { status: string; errorMessage: string | null } | null;
  isPipelineRunning: boolean;
  onRunPipeline: () => void;
  profiles: Profile[];
}

export const SwipeDeck: React.FC<SwipeDeckProps> = ({
  pipelineTerminalEvent,
  isPipelineRunning,
  onRunPipeline,
  profiles,
}) => {
  const { cards, isLoading, isError, act, canUndo, undo, refetch } =
    useSwipeDeck({
      pipelineTerminalEvent,
      isPipelineRunning,
    });
  const cardRef = useRef<SwipeCardHandle>(null);

  const [filters, setFilters] = useState<SwipeFilterState>(EMPTY_SWIPE_FILTERS);
  const [sheetOpen, setSheetOpen] = useState(false);

  const titles = useMemo(
    () => collectProfileSearchTitles(profiles),
    [profiles],
  );
  const knownProfileIds = useMemo(
    () => profiles.map((profile) => profile.id),
    [profiles],
  );
  // The trigger's indicator keys on the EFFECTIVE picks (stale picks — a
  // deleted profile, an edited-away term — no longer narrow, so they must not
  // light it), while Clear keys on the raw ones (there is still state to
  // clear).
  const filtersActive = hasActiveSwipeFilters(
    effectiveSwipeFilters(filters, knownProfileIds, titles),
  );
  const deck = useMemo(
    () => applySwipeFilters(cards, filters, knownProfileIds, titles),
    [cards, filters, knownProfileIds, titles],
  );

  // The sheet rides OUTSIDE the branch switch so an open drawer survives the
  // deck emptying (or an error) under it instead of being unmounted mid-swipe.
  const sheet = (
    <SwipeFilterSheet
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      filters={filters}
      onFiltersChange={setFilters}
      profiles={profiles}
      titles={titles}
    />
  );

  return (
    <>
      <SwipeDeckBody
        cards={cards}
        deck={deck}
        isLoading={isLoading}
        isError={isError}
        refetch={refetch}
        isPipelineRunning={isPipelineRunning}
        onRunPipeline={onRunPipeline}
        act={act}
        canUndo={canUndo}
        undo={undo}
        cardRef={cardRef}
        filtersActive={filtersActive}
        onOpenFilters={() => setSheetOpen(true)}
        onClearFilters={() => setFilters(EMPTY_SWIPE_FILTERS)}
      />
      {sheet}
    </>
  );
};

interface SwipeDeckBodyProps {
  cards: ReturnType<typeof useSwipeDeck>["cards"];
  deck: ReturnType<typeof useSwipeDeck>["cards"];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  isPipelineRunning: boolean;
  onRunPipeline: () => void;
  act: ReturnType<typeof useSwipeDeck>["act"];
  canUndo: boolean;
  undo: () => Promise<void>;
  cardRef: React.RefObject<SwipeCardHandle>;
  filtersActive: boolean;
  onOpenFilters: () => void;
  onClearFilters: () => void;
}

const SwipeDeckBody: React.FC<SwipeDeckBodyProps> = ({
  cards,
  deck,
  isLoading,
  isError,
  refetch,
  isPipelineRunning,
  onRunPipeline,
  act,
  canUndo,
  undo,
  cardRef,
  filtersActive,
  onOpenFilters,
  onClearFilters,
}) => {
  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">
          Couldn't load the inbox.
        </p>
        <Button variant="outline" size="sm" onClick={refetch}>
          Retry
        </Button>
      </div>
    );
  }

  const top = deck[0];
  const next = deck[1];

  if (!top) {
    // Cards exist but every one is filtered out — blame the filters, not the
    // pipeline, and offer the ways out (undo included: swiping the last
    // matching card lands here, and the action bar's undo went with it).
    if (cards.length > 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <p className="text-base font-medium">No cards match your filters</p>
          <p className="text-sm text-muted-foreground">
            {cards.length} job{cards.length === 1 ? "" : "s"} hidden by the
            current filters.
          </p>
          <div className="flex items-center gap-2">
            {canUndo && (
              <Button
                variant="ghost"
                size="sm"
                onClick={undo}
                className="gap-1.5 text-muted-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Undo
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onOpenFilters}>
              Adjust filters
            </Button>
            <Button size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-base font-medium">Inbox empty</p>
        <p className="text-sm text-muted-foreground">
          Run the pipeline to discover new jobs to triage.
        </p>
        <Button
          onClick={onRunPipeline}
          disabled={isPipelineRunning}
          className="gap-2"
        >
          {isPipelineRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {isPipelineRunning ? "Running…" : "Run pipeline"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 pb-4">
      <FitCountChips jobs={deck} />
      <div className="relative mx-auto min-h-0 w-full max-w-md flex-1">
        {next && (
          <div className="pointer-events-none absolute inset-0 scale-[0.97] opacity-90">
            <SwipeCardContent job={next} />
          </div>
        )}
        <SwipeCard
          key={top.id}
          ref={cardRef}
          job={top}
          onCommit={(action) => act(top, action)}
        />
      </div>
      <SwipeActionBar
        disabled={false}
        canUndo={canUndo}
        filtersActive={filtersActive}
        onSkip={() => cardRef.current?.flyOut("skip")}
        onBacklog={() => cardRef.current?.flyOut("move_to_backlog")}
        onTailor={() => cardRef.current?.flyOut("move_to_ready")}
        onUndo={undo}
        onOpenFilters={onOpenFilters}
      />
    </div>
  );
};
