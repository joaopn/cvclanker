import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PipelineProgressEvent, RunTrigger } from "@shared/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handlers = {
  onOpen?: () => void;
  onMessage: (payload: PipelineProgressEvent) => void;
  onError?: () => void;
};

const lastHandlers: { current: Handlers | null } = { current: null };
const subscribedTriggers: RunTrigger[] = [];
const retained = new Map<RunTrigger, PipelineProgressEvent>();

// The banner reads the SHARED progress stream, so that is the boundary to
// stub — mocking the raw SSE helper would leave the module's own fan-out and
// replay in the way.
//
// The stub keeps ONE property of the real module that the banner's behaviour
// turns on: each partition's last event is retained and replayed SYNCHRONOUSLY
// inside the subscribe call. That is what makes a partition swap land in a
// single React commit, so a test that dropped it would see an intermediate
// empty render the real app never shows.
vi.mock("@client/lib/progress-stream", () => ({
  subscribeToPipelineProgress: vi.fn(
    (watcher: {
      trigger: RunTrigger;
      onEvent: (event: PipelineProgressEvent) => void;
      onConnectionChange?: (connected: boolean) => void;
    }): (() => void) => {
      subscribedTriggers.push(watcher.trigger);
      lastHandlers.current = {
        onMessage: (event: PipelineProgressEvent) => {
          retained.set(event.trigger ?? watcher.trigger, event);
          watcher.onEvent(event);
        },
        onOpen: () => watcher.onConnectionChange?.(true),
        onError: () => watcher.onConnectionChange?.(false),
      };
      const replay = retained.get(watcher.trigger);
      if (replay) watcher.onEvent(replay);
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
const dismissRunBanner = vi.fn(
  async (_startedAt?: string, _trigger?: RunTrigger) => ({ dismissed: true }),
);
const getRunJobs = vi.fn(
  async (
    source: string,
    bucket: string,
    _profileId?: string,
    _trigger?: RunTrigger,
  ) => ({ source, bucket, jobs: [] }),
);
vi.mock("@client/api", () => ({
  dismissRunBanner: (startedAt?: string, trigger?: RunTrigger) =>
    dismissRunBanner(startedAt, trigger),
  getRunJobs: (
    source: string,
    bucket: string,
    profileId?: string,
    trigger?: RunTrigger,
  ) => getRunJobs(source, bucket, profileId, trigger),
}));

import { computePercentage, PipelineRunBanner } from "./PipelineRunBanner";

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
    subscribedTriggers.length = 0;
    retained.clear();
    dismissRunBanner.mockClear();
    getRunJobs.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when isRunning is false and no event yet", () => {
    const { container } = render(
      <PipelineRunBanner trigger="manual" isRunning={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("names the live-status step and moves its bar with it", () => {
    // `stepLabels` is an exhaustive Record, so tsc forces an entry to exist —
    // what it cannot check is that the banner reaches it for this step at all,
    // which is what this pins. (The band next door is the genuinely silent
    // half.) A step the run spends minutes in, showing nothing, is the hang
    // this step was given a name to avoid.
    render(<PipelineRunBanner isRunning />);
    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        step: "live_status",
        message: "Checking LinkedIn live status (5/10)...",
        liveStatusChecked: 5,
        liveStatusTotal: 10,
      });
    });

    expect(screen.getByText("Live status")).toBeInTheDocument();
  });

  it("gives the live-status step its own progress band", () => {
    // Asserted on the exported function rather than the rendered bar: the bar
    // is a Radix primitive whose ARIA surface is its business, while the band
    // is ours — and computePercentage's `default: return 0` arm means a step
    // missing from the switch parks at 0% with nothing to catch it.
    const at = (checked: number, total: number) =>
      computePercentage({
        ...baseEvent,
        step: "live_status",
        liveStatusChecked: checked,
        liveStatusTotal: total,
      });

    // Between scoring (ends at 50) and processing (now starts at 55).
    expect(at(0, 10)).toBe(50);
    expect(at(5, 10)).toBe(52.5);
    expect(at(10, 10)).toBe(55);
    // Before the first row is counted there is nothing to divide by.
    expect(computePercentage({ ...baseEvent, step: "live_status" })).toBe(50);
  });

  it("renders a per-platform table when running", () => {
    render(<PipelineRunBanner trigger="manual" isRunning />);
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
    render(<PipelineRunBanner trigger="manual" isRunning />);
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
    const { rerender } = render(
      <PipelineRunBanner trigger="manual" isRunning />,
    );
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
    rerender(<PipelineRunBanner trigger="manual" isRunning={false} />);
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();
  });

  it("hides after the user dismisses it", () => {
    render(<PipelineRunBanner trigger="manual" isRunning />);
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
    render(<PipelineRunBanner trigger="manual" isRunning={false} />);

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
    render(<PipelineRunBanner trigger="manual" isRunning={false} />);

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
    render(<PipelineRunBanner trigger="manual" isRunning />);
    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        startedAt: "2026-05-22T10:00:00.000Z",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    // Named, so a stale tab cannot hide a run that started after its click —
    // and partitioned, so it cannot hide the OTHER table's run either.
    expect(dismissRunBanner).toHaveBeenCalledWith(
      "2026-05-22T10:00:00.000Z",
      "manual",
    );
  });

  it("dismisses the partition it renders, not the one the app started with", () => {
    render(<PipelineRunBanner trigger="schedule" isRunning />);
    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        trigger: "schedule",
        startedAt: "2026-08-29T10:00:00.000Z",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(dismissRunBanner).toHaveBeenCalledWith(
      "2026-08-29T10:00:00.000Z",
      "schedule",
    );
  });

  it("drops the run it was showing when its partition binding changes", () => {
    const { rerender } = render(
      <PipelineRunBanner trigger="manual" isRunning={false} />,
    );
    act(() => {
      lastHandlers.current?.onMessage({ ...baseEvent, step: "completed" });
    });
    expect(screen.getByText("LinkedIn")).toBeInTheDocument();

    rerender(<PipelineRunBanner trigger="schedule" isRunning={false} />);

    // The stream replays only a partition that HAS a retained run, so keeping
    // the old one would leave another table's funnel on screen — and the
    // Dismiss button would then name a run the new partition never had.
    expect(screen.queryByText("LinkedIn")).not.toBeInTheDocument();
    expect(subscribedTriggers).toEqual(["manual", "schedule"]);
  });

  it("drops a hand-picked page when the partition changes under a similar chain", () => {
    // Both partitions' chains open on the SAME Search Profile — the steady
    // state once a profile is both scheduled and run by hand.
    const finishedChain = {
      ...chainEvent,
      step: "completed" as const,
      profileRun: null,
    };

    // Give the scheduled partition a run to replay, so the swap back to it
    // lands in ONE commit rather than passing through an empty render.
    const { rerender } = render(
      <PipelineRunBanner trigger="schedule" isRunning={false} />,
    );
    act(() => {
      lastHandlers.current?.onMessage({
        ...finishedChain,
        trigger: "schedule",
      });
    });

    rerender(<PipelineRunBanner trigger="manual" isRunning={false} />);
    act(() => {
      lastHandlers.current?.onMessage(finishedChain);
    });
    fireEvent.click(screen.getByRole("button", { name: "Previous profile" }));
    expect(screen.getByText("Hiring Cafe")).toBeInTheDocument();

    rerender(<PipelineRunBanner trigger="schedule" isRunning={false} />);

    // The render-phase reset keys on the chain's FIRST profile, which has not
    // changed — so nothing else clears a pin taken on the other table, and the
    // scheduled run would open on the page the user picked for the manual one.
    expect(screen.getByText("Working Nomads")).toBeInTheDocument();
    expect(screen.queryByText("Hiring Cafe")).not.toBeInTheDocument();
  });

  it("watches only the partition it was told to render", () => {
    render(<PipelineRunBanner trigger="schedule" isRunning />);
    // The stream fans out per partition, so this IS the filter: a banner that
    // subscribed without naming one would receive the other table's events.
    expect(subscribedTriggers).toEqual(["schedule"]);
  });

  it("reads a funnel count's jobs from its own partition", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    render(<PipelineRunBanner trigger="schedule" isRunning={false} />, {
      wrapper,
    });
    act(() => {
      lastHandlers.current?.onMessage({
        ...baseEvent,
        trigger: "schedule",
        step: "completed",
        sourceStats: [
          sourceRow("hiringcafe", "Hiring Cafe", { jobsScraped: 4 }),
        ],
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "4" }));

    // Captures are stored per partition, so a read that did not name one would
    // answer a scheduled run's count with the manual table's jobs.
    await vi.waitFor(() => {
      expect(getRunJobs).toHaveBeenCalledWith(
        "hiringcafe",
        "scraped",
        undefined,
        "schedule",
      );
    });
  });

  it("puts the banner back when the dismissal fails", async () => {
    dismissRunBanner.mockRejectedValueOnce(new Error("offline"));
    render(<PipelineRunBanner trigger="manual" isRunning />);
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
    render(<PipelineRunBanner trigger="manual" isRunning={false} />);

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
    render(<PipelineRunBanner trigger="manual" isRunning={false} />);
    expect(lastHandlers.current).not.toBeNull();
  });

  it("stays out of the way when the server has no run to describe", () => {
    render(<PipelineRunBanner trigger="manual" isRunning={false} />);

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
    render(<PipelineRunBanner trigger="manual" isRunning />);

    act(() => {
      lastHandlers.current?.onMessage({ ...baseEvent, dismissed: true });
    });

    // Dismissed in another tab: the banner belongs to the run, not the browser.
    expect(screen.queryByText("LinkedIn")).not.toBeInTheDocument();
  });

  it("re-arms on a new run (new startedAt) after being dismissed", () => {
    render(<PipelineRunBanner trigger="manual" isRunning />);
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
    render(<PipelineRunBanner trigger="manual" isRunning />);
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
    render(<PipelineRunBanner trigger="manual" isRunning />);
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
    const { rerender } = render(
      <PipelineRunBanner trigger="manual" isRunning />,
    );
    act(() => {
      lastHandlers.current?.onMessage(baseEvent);
    });
    expect(screen.getByText("Live")).toBeInTheDocument();

    act(() => {
      lastHandlers.current?.onMessage({ ...baseEvent, step: "completed" });
    });
    rerender(<PipelineRunBanner trigger="manual" isRunning={false} />);

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
      <PipelineRunBanner
        trigger="manual"
        isRunning
        onRerunSource={onRerunSource}
      />,
    );
    act(() => {
      lastHandlers.current?.onMessage({
        ...chainEvent,
        step: "completed",
        profileRun: null,
      });
    });
    rerender(
      <PipelineRunBanner
        trigger="manual"
        isRunning={false}
        onRerunSource={onRerunSource}
      />,
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
    render(
      <PipelineRunBanner
        trigger="manual"
        isRunning
        onRerunSource={onRerunSource}
      />,
    );
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
      <PipelineRunBanner
        trigger="manual"
        isRunning
        onRerunSource={onRerunSource}
      />,
    );
    act(() => {
      lastHandlers.current?.onMessage({ ...baseEvent, step: "completed" });
    });
    rerender(
      <PipelineRunBanner
        trigger="manual"
        isRunning={false}
        onRerunSource={onRerunSource}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /re-run LinkedIn/i }));
    expect(onRerunSource).toHaveBeenCalledWith("linkedin");
  });

  it("retries every failed source on the page with one click", () => {
    const onRerunSources = vi.fn();
    const { rerender } = render(
      <PipelineRunBanner
        trigger="manual"
        isRunning
        onRerunSources={onRerunSources}
      />,
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
      <PipelineRunBanner
        trigger="manual"
        isRunning={false}
        onRerunSources={onRerunSources}
      />,
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
    render(
      <PipelineRunBanner
        trigger="manual"
        isRunning
        onRerunSources={onRerunSources}
      />,
    );
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
      <PipelineRunBanner
        trigger="manual"
        isRunning
        onRerunSources={onRerunSources}
      />,
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
      <PipelineRunBanner
        trigger="manual"
        isRunning={false}
        onRerunSources={onRerunSources}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /retry all/i }));
    expect(onRerunSources).toHaveBeenCalledWith(["linkedin"]);
  });
});
