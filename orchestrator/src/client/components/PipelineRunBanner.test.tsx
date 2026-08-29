import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PipelineProgressEvent } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handlers = {
  onOpen?: () => void;
  onMessage: (payload: PipelineProgressEvent) => void;
  onError?: () => void;
};

const lastHandlers: { current: Handlers | null } = { current: null };

// The banner reads the SHARED progress stream, so that is the boundary to
// stub — mocking the raw SSE helper would leave the module's own fan-out and
// replay in the way.
vi.mock("@client/lib/progress-stream", () => ({
  subscribeToPipelineProgress: vi.fn(
    (watcher: {
      onEvent: (event: PipelineProgressEvent) => void;
      onConnectionChange?: (connected: boolean) => void;
    }): (() => void) => {
      lastHandlers.current = {
        onMessage: watcher.onEvent,
        onOpen: () => watcher.onConnectionChange?.(true),
        onError: () => watcher.onConnectionChange?.(false),
      };
      watcher.onConnectionChange?.(true);
      return () => {
        lastHandlers.current = null;
      };
    },
  ),
}));

// Unmocked, the dismiss button fired a REAL fetch at a relative URL: it
// rejected, the catch ran outside `act()`, and both dismiss tests passed while
// proving neither that the POST is sent nor that a failure restores the banner.
const dismissRunBanner = vi.fn(async (_startedAt?: string) => ({
  dismissed: true,
}));
vi.mock("@client/api", () => ({
  dismissRunBanner: (startedAt?: string) => dismissRunBanner(startedAt),
}));

import { PipelineRunBanner } from "./PipelineRunBanner";

const baseEvent: PipelineProgressEvent = {
  step: "crawling",
  message: "Fetching jobs from sources...",
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
  startedAt: "2026-05-22T10:00:00.000Z",
  sourceStats: [
    {
      id: "linkedin",
      label: "LinkedIn",
      status: "running",
      jobsScraped: 0,
      jobsImported: 0,
      jobsReposted: 0,
      jobsDuplicated: 0,
      jobsUnmappable: 0,
      jobsFiltered: 0,
      jobsRejected: 0,
      startedAt: "2026-05-22T10:00:00.000Z",
    },
    {
      id: "indeed",
      label: "Indeed",
      status: "running",
      jobsScraped: 0,
      jobsImported: 0,
      jobsReposted: 0,
      jobsDuplicated: 0,
      jobsUnmappable: 0,
      jobsFiltered: 0,
      jobsRejected: 0,
      startedAt: "2026-05-22T10:00:00.000Z",
    },
  ],
};

const sourceRow = (
  id: string,
  label: string,
  overrides: Partial<PipelineProgressEvent["sourceStats"][number]> = {},
): PipelineProgressEvent["sourceStats"][number] => ({
  id,
  label,
  status: "completed",
  jobsScraped: 0,
  jobsImported: 0,
  jobsReposted: 0,
  jobsDuplicated: 0,
  jobsUnmappable: 0,
  jobsFiltered: 0,
  jobsRejected: 0,
  ...overrides,
});

/** A chain on its second profile: page 1 finished, page 2 is still crawling. */
const chainEvent: PipelineProgressEvent = {
  ...baseEvent,
  profileRun: { id: "p2", name: "Berlin", index: 2, total: 2 },
  sourceStats: [
    sourceRow("workingnomads", "Working Nomads", { status: "running" }),
  ],
  profileRuns: [
    {
      profile: { id: "p1", name: "Vienna", index: 1, total: 2 },
      sourceStats: [
        sourceRow("hiringcafe", "Hiring Cafe", {
          status: "failed",
          error: "429 from upstream",
        }),
      ],
    },
    {
      profile: { id: "p2", name: "Berlin", index: 2, total: 2 },
      sourceStats: [
        sourceRow("workingnomads", "Working Nomads", { status: "running" }),
      ],
    },
  ],
};

describe("PipelineRunBanner", () => {
  beforeEach(() => {
    lastHandlers.current = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when isRunning is false and no event yet", () => {
    const { container } = render(<PipelineRunBanner isRunning={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a per-platform table when running", () => {
    render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage(baseEvent);
    });

    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
    expect(screen.getByText("Indeed")).toBeInTheDocument();
    expect(screen.getByText("Pipeline")).toBeInTheDocument();
  });

  it("surfaces a source's unreadable-item count, including when it mapped none", () => {
    // The zero case is the severe one: a source that returned items and could
    // read NONE of them renders a bare 0, which is the silence B35 is about.
    render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        sourceStats: [
          sourceRow("linkedin", "LinkedIn", {
            status: "completed",
            jobsScraped: 12,
            jobsUnmappable: 4,
          }),
          sourceRow("indeed", "Indeed", {
            status: "completed",
            jobsScraped: 0,
            jobsUnmappable: 7,
          }),
        ],
      });
    });

    expect(
      screen.getByTitle(/4 returned item\(s\) could not be read/),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle(/7 returned item\(s\) could not be read/),
    ).toBeInTheDocument();
  });

  it("stays visible after the run reaches a terminal step", () => {
    const { rerender } = render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage(baseEvent);
    });
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();

    const terminal: PipelineProgressEvent = {
      ...baseEvent,
      step: "completed",
      message: "Pipeline complete!",
      completedAt: "2026-05-22T10:05:00.000Z",
      sourceStats: baseEvent.sourceStats.map((row) => ({
        ...row,
        status: "completed",
        completedAt: "2026-05-22T10:05:00.000Z",
        durationMs: 300_000,
        jobsScraped: 12,
      })),
    };
    act(() => {
      lastHandlers.current?.onMessage(terminal);
    });

    // Banner is still mounted with the per-platform table now showing final counts.
    rerender(<PipelineRunBanner isRunning={false} />);
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();
  });

  it("hides after the user dismisses it", () => {
    render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage(baseEvent);
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText("LinkedIn")).not.toBeInTheDocument();
  });

  /**
   * The bug that made a prod run look like it had vanished: the banner
   * subscribed only while a run was in flight, so reopening the page after one
   * had ended — including one that DIED — showed nothing at all, even though
   * the server still holds that run's funnel and replays it on connect.
   */
  it("shows a run that already ended, on a page opened afterwards", () => {
    render(<PipelineRunBanner isRunning={false} />);

    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        step: "failed",
        message: "Pipeline failed",
        error: "LLM rate limit reached",
      });
    });

    expect(screen.getByText(/rate limit/i)).toBeInTheDocument();
  });

  it("shows why a run failed even when its sources reported", () => {
    render(<PipelineRunBanner isRunning={false} />);

    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        step: "failed",
        error: "LLM rate limit reached",
      });
    });

    // A rate limit during scoring kills the run with a healthy funnel, and the
    // reason used to be hidden precisely because the funnel had rows.
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
    expect(screen.getByText(/rate limit/i)).toBeInTheDocument();
  });

  it("sends the dismissal, naming the run it applies to", () => {
    render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        startedAt: "2026-05-22T10:00:00.000Z",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    // Named, so a stale tab cannot hide a run that started after its click.
    expect(dismissRunBanner).toHaveBeenCalledWith("2026-05-22T10:00:00.000Z");
  });

  it("puts the banner back when the dismissal fails", async () => {
    dismissRunBanner.mockRejectedValueOnce(new Error("offline"));
    render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage(baseEvent);
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText("LinkedIn")).not.toBeInTheDocument();

    // Hiding it locally while the server still shows it to everyone else would
    // be the worst of both worlds.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
  });

  it("keeps showing a chain sitting idle between profiles", () => {
    render(<PipelineRunBanner isRunning={false} />);

    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        step: "idle",
        message: "Ready",
        profileRun: { id: "p2", name: "Second", index: 2, total: 3 },
      });
    });

    // A chain resets to idle between legs; blanking the banner there would
    // take its retained pages with it mid-run.
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
  });

  it("subscribes even when nothing is running", () => {
    render(<PipelineRunBanner isRunning={false} />);
    expect(lastHandlers.current).not.toBeNull();
  });

  it("stays out of the way when the server has no run to describe", () => {
    render(<PipelineRunBanner isRunning={false} />);

    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        step: "idle",
        message: "Ready",
      });
    });

    // A fresh boot, or a restart since the last run — nothing to show.
    expect(screen.queryByText("LinkedIn")).not.toBeInTheDocument();
  });

  it("hides a run the SERVER says was dismissed, without being clicked", () => {
    render(<PipelineRunBanner isRunning />);

    act(() => {
      lastHandlers.current?.onMessage({ ...baseEvent, dismissed: true });
    });

    // Dismissed in another tab: the banner belongs to the run, not the browser.
    expect(screen.queryByText("LinkedIn")).not.toBeInTheDocument();
  });

  it("re-arms on a new run (new startedAt) after being dismissed", () => {
    render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage(baseEvent);
    });
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText("LinkedIn")).not.toBeInTheDocument();

    const nextRun: PipelineProgressEvent = {
      ...baseEvent,
      startedAt: "2026-05-22T11:00:00.000Z",
    };
    act(() => {
      lastHandlers.current?.onMessage(nextRun);
    });
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
  });

  it("follows the running profile and pages back to an earlier one", () => {
    render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage(chainEvent);
    });

    // Follows the profile that is running.
    expect(screen.getByText("Profile 2 of 2 · Berlin")).toBeInTheDocument();
    expect(screen.getByText("Working Nomads")).toBeInTheDocument();
    expect(screen.queryByText("Hiring Cafe")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /previous profile/i }));

    // The earlier profile's table — the one a chain used to throw away — with
    // its failed source and the error it failed on.
    expect(screen.getByText("Profile 1 of 2 · Vienna")).toBeInTheDocument();
    expect(screen.getByText("Hiring Cafe")).toBeInTheDocument();
    expect(screen.getByText("429 from upstream")).toBeInTheDocument();
    expect(screen.queryByText("Working Nomads")).not.toBeInTheDocument();
  });

  it("stays on the pinned page when the chain moves on, until Follow live", () => {
    render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage(chainEvent);
    });
    fireEvent.click(screen.getByRole("button", { name: /previous profile/i }));

    // A later event from the running profile must not yank the user's page.
    act(() => {
      lastHandlers.current?.onMessage({
        ...chainEvent,
        message: "still crawling",
      });
    });
    expect(screen.getByText("Profile 1 of 2 · Vienna")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /follow live/i }));
    expect(screen.getByText("Profile 2 of 2 · Berlin")).toBeInTheDocument();
  });

  it("stops showing the stream indicator once the run is over", () => {
    const { rerender } = render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage(baseEvent);
    });
    expect(screen.getByText("Live")).toBeInTheDocument();

    act(() => {
      lastHandlers.current?.onMessage({ ...baseEvent, step: "completed" });
    });
    rerender(<PipelineRunBanner isRunning={false} />);

    // The banner outlives the run, but the stream it reports on does not: the
    // subscription is torn down with the run, so a "Connecting…" left up here
    // reads as a broken connection that will never come back.
    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).not.toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
  });

  it("re-runs a failed source against the profile whose page it sits on", () => {
    const onRerunSource = vi.fn();
    const { rerender } = render(
      <PipelineRunBanner isRunning onRerunSource={onRerunSource} />,
    );
    act(() => {
      lastHandlers.current?.onMessage({
        ...chainEvent,
        step: "completed",
        profileRun: null,
      });
    });
    rerender(
      <PipelineRunBanner isRunning={false} onRerunSource={onRerunSource} />,
    );

    // The chain ended on page 2; the failure to retry is back on page 1.
    fireEvent.click(screen.getByRole("button", { name: /previous profile/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /re-run Hiring Cafe/i }),
    );

    expect(onRerunSource).toHaveBeenCalledWith("hiringcafe", "p1");
  });

  it("offers no re-run while the chain is still running", () => {
    const onRerunSource = vi.fn();
    render(<PipelineRunBanner isRunning onRerunSource={onRerunSource} />);
    act(() => {
      lastHandlers.current?.onMessage(chainEvent);
    });

    // Profile 2 is mid-crawl: a partial run started now would collide with it.
    expect(
      screen.queryByRole("button", { name: /re-run/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the re-run button on a single-profile run", () => {
    const onRerunSource = vi.fn();
    const { rerender } = render(
      <PipelineRunBanner isRunning onRerunSource={onRerunSource} />,
    );
    act(() => {
      lastHandlers.current?.onMessage({ ...baseEvent, step: "completed" });
    });
    rerender(
      <PipelineRunBanner isRunning={false} onRerunSource={onRerunSource} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /re-run LinkedIn/i }));
    expect(onRerunSource).toHaveBeenCalledWith("linkedin");
  });

  it("retries every failed source on the page with one click", () => {
    const onRerunSources = vi.fn();
    const { rerender } = render(
      <PipelineRunBanner isRunning onRerunSources={onRerunSources} />,
    );
    act(() => {
      lastHandlers.current?.onMessage({
        ...chainEvent,
        step: "completed",
        profileRun: null,
        profileRuns: [
          {
            profile: { id: "p1", name: "Vienna", index: 1, total: 2 },
            sourceStats: [
              sourceRow("hiringcafe", "Hiring Cafe", {
                status: "failed",
                error: "429 from upstream",
              }),
              sourceRow("workingnomads", "Working Nomads"),
              sourceRow("apify:inst-1", "LinkedIn (Apify)", {
                status: "failed",
                error: "actor timed out",
              }),
            ],
          },
          chainEvent.profileRuns?.[1] as NonNullable<
            PipelineProgressEvent["profileRuns"]
          >[number],
        ],
      });
    });
    rerender(
      <PipelineRunBanner isRunning={false} onRerunSources={onRerunSources} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /previous profile/i }));
    expect(screen.getByText("2 failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry all/i }));

    // Both failures, as the page lists them, aimed at that page.
    expect(onRerunSources).toHaveBeenCalledWith(
      ["hiringcafe", "apify:inst-1"],
      "p1",
    );
  });

  it("offers no Retry all while the chain is still running", () => {
    const onRerunSources = vi.fn();
    render(<PipelineRunBanner isRunning onRerunSources={onRerunSources} />);
    act(() => {
      lastHandlers.current?.onMessage(chainEvent);
    });
    fireEvent.click(screen.getByRole("button", { name: /previous profile/i }));

    // Page 1's failure shows while profile 2 crawls, but nothing may start.
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /retry all/i }),
    ).not.toBeInTheDocument();
  });

  it("retries a single-profile run's failures against the default profile", () => {
    const onRerunSources = vi.fn();
    const { rerender } = render(
      <PipelineRunBanner isRunning onRerunSources={onRerunSources} />,
    );
    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        step: "completed",
        sourceStats: [
          sourceRow("linkedin", "LinkedIn", {
            status: "failed",
            error: "blocked",
          }),
          sourceRow("indeed", "Indeed"),
        ],
      });
    });
    rerender(
      <PipelineRunBanner isRunning={false} onRerunSources={onRerunSources} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /retry all/i }));
    expect(onRerunSources).toHaveBeenCalledWith(["linkedin"]);
  });
});
