import type { PipelineProgressEvent, RunTrigger } from "@shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";

type Handlers = {
  onOpen?: () => void;
  onMessage: (payload: PipelineProgressEvent) => void;
  onError?: (info: { fatal: boolean }) => void;
};

const sockets: { handlers: Handlers; closed: boolean }[] = [];

// Mocked at the raw-SSE boundary, so the fan-out and the per-partition replay
// under test are the real ones.
vi.mock("@client/lib/sse", () => ({
  subscribeToEventSource: vi.fn((_url: string, handlers: Handlers) => {
    const socket = { handlers, closed: false };
    sockets.push(socket);
    return () => {
      socket.closed = true;
    };
  }),
}));

import {
  resetPipelineProgressStream,
  subscribeToPipelineProgress,
} from "./progress-stream";

const event = (
  trigger: RunTrigger,
  overrides: Partial<PipelineProgressEvent> = {},
): PipelineProgressEvent =>
  ({
    step: "crawling",
    message: `${trigger} run`,
    trigger,
    dismissed: false,
    crawlingSource: null,
    crawlingSourcesCompleted: 0,
    crawlingSourcesTotal: 0,
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
    ...overrides,
  }) as PipelineProgressEvent;

const emit = (payload: unknown) => {
  for (const socket of sockets) {
    if (!socket.closed) socket.handlers.onMessage(payload as never);
  }
};

afterEach(() => {
  resetPipelineProgressStream();
  sockets.length = 0;
  vi.clearAllMocks();
});

describe("progress stream", () => {
  it("opens one socket however many watchers there are", () => {
    subscribeToPipelineProgress({ trigger: "manual", onEvent: vi.fn() });
    subscribeToPipelineProgress({ trigger: "manual", onEvent: vi.fn() });
    subscribeToPipelineProgress({ trigger: "schedule", onEvent: vi.fn() });

    expect(sockets).toHaveLength(1);
  });

  it("delivers an event only to the partition it belongs to", () => {
    const manual = vi.fn();
    const scheduled = vi.fn();
    subscribeToPipelineProgress({ trigger: "manual", onEvent: manual });
    subscribeToPipelineProgress({ trigger: "schedule", onEvent: scheduled });

    emit(event("schedule"));

    // The SERVER fan-out has no partition filter — it delivers every event to
    // every listener — so this is the only thing keeping a scheduled run out of
    // the manual banner.
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(manual).not.toHaveBeenCalled();

    emit(event("manual"));
    expect(manual).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it("replays each partition's own last event to a late watcher", () => {
    subscribeToPipelineProgress({ trigger: "manual", onEvent: vi.fn() });
    emit(event("manual", { message: "manual latest" }));
    emit(event("schedule", { message: "scheduled latest" }));

    const late = vi.fn();
    subscribeToPipelineProgress({ trigger: "manual", onEvent: late });

    // One retained event per partition: a single slot would have let the
    // scheduled run overwrite what a manual watcher replays.
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0][0].message).toBe("manual latest");
  });

  it("replays nothing to a partition that has not emitted", () => {
    subscribeToPipelineProgress({ trigger: "manual", onEvent: vi.fn() });
    emit(event("manual"));

    const scheduled = vi.fn();
    subscribeToPipelineProgress({ trigger: "schedule", onEvent: scheduled });

    expect(scheduled).not.toHaveBeenCalled();
  });

  it("treats an event it cannot classify as the manual table's", () => {
    const manual = vi.fn();
    const scheduled = vi.fn();
    subscribeToPipelineProgress({ trigger: "manual", onEvent: manual });
    subscribeToPipelineProgress({ trigger: "schedule", onEvent: scheduled });

    // Unreachable while the server stamps every write, so this only decides how
    // a bug behaves: landing on the table every consumer watches is wrong
    // loudly, where dropping it would lose a run silently.
    const { trigger: _dropped, ...untagged } = event("manual");
    emit(untagged);
    emit({ ...event("manual"), trigger: "nonsense" });

    expect(manual).toHaveBeenCalledTimes(2);
    expect(scheduled).not.toHaveBeenCalled();
  });

  it("reports connection state to every watcher, whatever its partition", () => {
    const manual = vi.fn();
    const scheduled = vi.fn();
    subscribeToPipelineProgress({
      trigger: "manual",
      onEvent: vi.fn(),
      onConnectionChange: manual,
    });
    subscribeToPipelineProgress({
      trigger: "schedule",
      onEvent: vi.fn(),
      onConnectionChange: scheduled,
    });

    sockets[0].handlers.onOpen?.();

    // The socket is shared, so its state is not partitioned.
    expect(manual).toHaveBeenLastCalledWith(true);
    expect(scheduled).toHaveBeenLastCalledWith(true);
  });

  it("closes the socket only once the last watcher leaves", () => {
    const first = subscribeToPipelineProgress({
      trigger: "manual",
      onEvent: vi.fn(),
    });
    const second = subscribeToPipelineProgress({
      trigger: "schedule",
      onEvent: vi.fn(),
    });

    first();
    expect(sockets[0].closed).toBe(false);
    second();
    expect(sockets[0].closed).toBe(true);
  });

  it("keeps every partition's retained event across a full unsubscribe", () => {
    const unsubscribe = subscribeToPipelineProgress({
      trigger: "schedule",
      onEvent: vi.fn(),
    });
    emit(event("schedule", { message: "still the latest" }));
    unsubscribe();

    const remounted = vi.fn();
    subscribeToPipelineProgress({ trigger: "schedule", onEvent: remounted });

    // A finished run sends nothing more, so a remount that forgot would show an
    // empty banner forever.
    expect(remounted.mock.calls[0][0].message).toBe("still the latest");
  });
});
