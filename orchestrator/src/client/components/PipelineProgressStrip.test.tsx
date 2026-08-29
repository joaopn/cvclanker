import type { PipelineProgressEvent, RunTrigger } from "@shared/types";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Watcher = {
  trigger: RunTrigger;
  onEvent: (event: PipelineProgressEvent) => void;
};

const watchers: Watcher[] = [];

// The shared stream is the boundary: the strip used to hold a second raw socket
// to the same endpoint, and that is exactly what this file pins it off.
vi.mock("@client/lib/progress-stream", () => ({
  subscribeToPipelineProgress: vi.fn((watcher: Watcher) => {
    watchers.push(watcher);
    return () => {
      const index = watchers.indexOf(watcher);
      if (index >= 0) watchers.splice(index, 1);
    };
  }),
}));

import { PipelineProgressStrip } from "./PipelineProgressStrip";

const baseEvent: PipelineProgressEvent = {
  step: "crawling",
  message: "Fetching jobs from sources...",
  trigger: "manual",
  dismissed: false,
  crawlingSource: "jobspy",
  crawlingSourcesCompleted: 0,
  crawlingSourcesTotal: 1,
  crawlingTermsProcessed: 0,
  crawlingTermsTotal: 0,
  crawlingListPagesProcessed: 0,
  crawlingListPagesTotal: 0,
  crawlingJobCardsFound: 0,
  crawlingJobPagesEnqueued: 0,
  crawlingJobPagesSkipped: 0,
  crawlingJobPagesProcessed: 0,
  jobsDiscovered: 0,
  jobsScored: 0,
  jobsProcessed: 0,
  totalToProcess: 0,
  sourceStats: [],
};

const emit = (overrides: Partial<PipelineProgressEvent>) => {
  act(() => {
    for (const watcher of watchers) {
      watcher.onEvent({ ...baseEvent, ...overrides });
    }
  });
};

describe("PipelineProgressStrip", () => {
  beforeEach(() => {
    watchers.length = 0;
  });

  it("watches the manual partition, and only while a run is in flight", () => {
    const { rerender } = render(<PipelineProgressStrip isRunning={false} />);
    expect(watchers).toHaveLength(0);

    rerender(<PipelineProgressStrip isRunning />);
    expect(watchers.map((watcher) => watcher.trigger)).toEqual(["manual"]);

    rerender(<PipelineProgressStrip isRunning={false} />);
    expect(watchers).toHaveLength(0);
  });

  it("renders the running run's step and percentage", () => {
    render(<PipelineProgressStrip isRunning />);
    emit({ step: "scoring", message: "Scoring jobs", jobsScored: 0 });

    expect(screen.getByText("Scoring")).toBeInTheDocument();
    expect(screen.getByText("Scoring jobs")).toBeInTheDocument();
  });

  it("ignores the finished run the stream replays when a new one starts", () => {
    render(<PipelineProgressStrip isRunning />);

    // What a subscriber actually receives on the press of Run: the shared
    // stream replays the last event BROADCAST, and `resetProgress` notifies
    // nobody — so the newest thing on the wire is the previous run's terminal.
    emit({ step: "completed", message: "Pipeline complete", jobsProcessed: 9 });

    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
    expect(screen.getByText("Starting pipeline…")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("keeps showing a chain whose profile has finished", () => {
    render(<PipelineProgressStrip isRunning />);
    emit({
      step: "completed",
      message: "Profile 1 done",
      profileRun: { id: "p1", name: "Vienna", index: 1, total: 2 },
    });

    // A TAGGED terminal is one leg of a chain the run outlives, so it is the
    // live run's own progress and must not be dropped with the replayed one.
    expect(screen.getByText("Profile 1 done")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("Crawling")).toBeInTheDocument();
  });
});
