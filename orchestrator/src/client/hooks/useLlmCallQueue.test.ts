import type { LlmCallRecord, LlmCallStreamEvent } from "@shared/types";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let emit: (event: LlmCallStreamEvent) => void = () => {};

vi.mock("@/client/lib/sse", () => ({
  subscribeToEventSource: (
    _url: string,
    handlers: {
      onOpen?: () => void;
      onMessage: (payload: LlmCallStreamEvent) => void;
    },
  ) => {
    handlers.onOpen?.();
    emit = handlers.onMessage;
    return () => {};
  },
}));

import { useLlmCallQueue } from "./useLlmCallQueue";

function call(
  id: string,
  status: LlmCallRecord["status"],
  startedAt: string,
): LlmCallRecord {
  return {
    id,
    label: "score job",
    subject: "Senior Consultant @ SYSTRA",
    model: status === "running" ? "filter-model" : "main-model",
    status,
    startedAt,
    completedAt: status === "running" ? null : startedAt,
    durationMs: status === "running" ? null : 120,
    totalTokens: null,
    jobId: null,
    errorMessage: null,
  };
}

// Ordered so the oldest is dropped first; the index keeps them unique.
function finished(index: number): LlmCallRecord {
  const startedAt = new Date(1_760_000_000_000 + index * 1000).toISOString();
  return call(`done-${index}`, "succeeded", startedAt);
}

describe("useLlmCallQueue", () => {
  beforeEach(() => {
    emit = () => {};
  });

  it("keeps every running call however many finish around it", () => {
    const { result } = renderHook(() => useLlmCallQueue(true));

    act(() => {
      emit({
        type: "snapshot",
        calls: [call("slow", "running", "2026-08-01T00:00:00.000Z")],
        requestId: "r1",
      });
    });

    for (let i = 0; i < 80; i += 1) {
      act(() => {
        emit({ type: "update", call: finished(i), requestId: "r1" });
      });
    }

    expect(result.current.active.map((entry) => entry.id)).toEqual(["slow"]);
  });

  it("drops the oldest finished calls instead of growing forever", () => {
    const { result } = renderHook(() => useLlmCallQueue(true));

    for (let i = 0; i < 80; i += 1) {
      act(() => {
        emit({ type: "update", call: finished(i), requestId: "r1" });
      });
    }

    const ids = result.current.recent.map((entry) => entry.id);
    expect(ids).toHaveLength(50);
    expect(ids).toContain("done-79");
    expect(ids).not.toContain("done-0");
  });

  it("moves a call out of Running when its completion arrives", () => {
    const { result } = renderHook(() => useLlmCallQueue(true));

    act(() => {
      emit({
        type: "snapshot",
        calls: [call("slow", "running", "2026-08-01T00:00:00.000Z")],
        requestId: "r1",
      });
    });
    expect(result.current.active).toHaveLength(1);

    act(() => {
      emit({
        type: "update",
        call: call("slow", "succeeded", "2026-08-01T00:00:00.000Z"),
        requestId: "r1",
      });
    });

    expect(result.current.active).toHaveLength(0);
    expect(result.current.recent.map((entry) => entry.id)).toEqual(["slow"]);
  });
});
