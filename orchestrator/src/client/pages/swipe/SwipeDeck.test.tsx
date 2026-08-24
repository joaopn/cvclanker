import { createJob } from "@shared/testing/factories.js";
import { defaultProfileConfig, type Job, type Profile } from "@shared/types.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwipeDeck } from "./SwipeDeck";
import type { UseSwipeDeckResult } from "./useSwipeDeck";

// The deck composes heavyweight children — the framer-motion card and the
// vaul drawer — that this test replaces with markers: the subject here is the
// branch logic (inbox-empty vs filtered-empty vs deck) and that the filter
// sheet survives every branch.
vi.mock("./SwipeCard", () => ({
  SwipeCard: ({ job }: { job: Job }) => (
    <div data-testid="swipe-card">{job.title}</div>
  ),
  SwipeCardContent: ({ job }: { job: Job }) => <div>{job.title}</div>,
}));

vi.mock("./SwipeFilterSheet", () => ({
  SwipeFilterSheet: ({
    onFiltersChange,
  }: {
    onFiltersChange: (filters: {
      fit: string[];
      profile: string[];
      title: string[];
    }) => void;
  }) => (
    <div data-testid="filter-sheet">
      <button
        type="button"
        onClick={() =>
          onFiltersChange({ fit: ["great_fit"], profile: [], title: [] })
        }
      >
        pick-great-fit
      </button>
    </div>
  ),
}));

const deckResult: UseSwipeDeckResult = {
  cards: [],
  isLoading: false,
  isError: false,
  act: vi.fn(),
  canUndo: false,
  undo: vi.fn(),
  refetch: vi.fn(),
};

vi.mock("./useSwipeDeck", () => ({
  useSwipeDeck: () => deckResult,
}));

const profile = (id: string): Profile => ({
  id,
  name: id,
  config: defaultProfileConfig(),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const renderDeck = () =>
  render(
    <SwipeDeck
      pipelineTerminalEvent={null}
      isPipelineRunning={false}
      onRunPipeline={vi.fn()}
      profiles={[profile("p1")]}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  deckResult.cards = [];
  deckResult.isLoading = false;
  deckResult.isError = false;
  deckResult.canUndo = false;
});

describe("SwipeDeck", () => {
  it("renders the filter sheet in the empty, error, and deck branches", () => {
    const empty = renderDeck();
    expect(screen.getByText("Inbox empty")).toBeInTheDocument();
    expect(screen.getByTestId("filter-sheet")).toBeInTheDocument();
    empty.unmount();

    deckResult.isError = true;
    const errored = renderDeck();
    expect(screen.getByText("Couldn't load the inbox.")).toBeInTheDocument();
    expect(screen.getByTestId("filter-sheet")).toBeInTheDocument();
    errored.unmount();

    deckResult.isError = false;
    deckResult.cards = [createJob({ id: "a", title: "Python Dev" })];
    renderDeck();
    expect(screen.getByTestId("swipe-card")).toBeInTheDocument();
    expect(screen.getByTestId("filter-sheet")).toBeInTheDocument();
  });

  it("shows the filtered-empty state — not Inbox empty — when filters hide every card, and Clear restores the deck", () => {
    deckResult.cards = [
      createJob({ id: "a", title: "Python Dev", suitabilityCategory: null }),
    ];
    renderDeck();
    expect(screen.getByTestId("swipe-card")).toBeInTheDocument();

    // Pick a fit badge no card matches (the only card is unscored).
    fireEvent.click(screen.getByText("pick-great-fit"));
    expect(screen.getByText("No cards match your filters")).toBeInTheDocument();
    expect(screen.queryByText("Inbox empty")).not.toBeInTheDocument();
    expect(
      screen.getByText("1 job hidden by the current filters."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByTestId("swipe-card")).toBeInTheDocument();
  });

  it("offers Undo from the filtered-empty state when a swipe can be undone", () => {
    deckResult.cards = [
      createJob({ id: "a", title: "Python Dev", suitabilityCategory: null }),
    ];
    deckResult.canUndo = true;
    renderDeck();
    fireEvent.click(screen.getByText("pick-great-fit"));

    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(deckResult.undo).toHaveBeenCalled();
  });

  it("feeds the fit-count chips the FILTERED deck", () => {
    deckResult.cards = [
      createJob({
        id: "a",
        title: "Python Dev",
        suitabilityCategory: "great_fit",
      }),
      createJob({ id: "b", title: "Go Dev", suitabilityCategory: "bad_fit" }),
    ];
    renderDeck();
    expect(screen.getByText("Great fit")).toBeInTheDocument();
    expect(screen.getByText("Bad fit")).toBeInTheDocument();

    fireEvent.click(screen.getByText("pick-great-fit"));
    expect(screen.getByText("Great fit")).toBeInTheDocument();
    expect(screen.queryByText("Bad fit")).not.toBeInTheDocument();
  });
});
