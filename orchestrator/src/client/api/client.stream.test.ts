import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./client";

describe("API client SSE streaming", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.__resetApiClientAuthForTests();
  });

  // Guards the generic `streamSseEvents` reader, not any one endpoint. It used
  // to ride on streamJobAction; that call is gone now that bulk actions are
  // detached, so it rides on the ghostwriter stream instead — leaving the
  // reader itself uncovered was the alternative.
  it("propagates handler errors and cancels the stream reader", async () => {
    const encoder = new TextEncoder();
    const cancelSpy = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"delta","text":"hi"}\n\n'),
        );
      },
      cancel() {
        cancelSpy();
      },
    });

    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      body: stream,
    } as Response);

    await expect(
      api.streamJobGhostwriterMessage(
        "job-1",
        { content: "hello" },
        {
          onEvent: () => {
            throw new Error("handler exploded");
          },
        },
      ),
    ).rejects.toThrow("handler exploded");

    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });
});
