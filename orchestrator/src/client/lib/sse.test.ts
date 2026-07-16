import { __resetApiClientAuthForTests } from "@client/api/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeToEventSource } from "./sse";

const { redirectToSignIn } = vi.hoisted(() => ({
  redirectToSignIn: vi.fn(),
}));

vi.mock("./auth-navigation", () => ({
  redirectToSignIn,
}));

describe("subscribeToEventSource", () => {
  afterEach(() => {
    __resetApiClientAuthForTests();
    vi.restoreAllMocks();
    redirectToSignIn.mockReset();
  });

  it("redirects to sign-in on a 401 without retrying or reconnecting", async () => {
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const onError = vi.fn();

    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      body: null,
    } as Response);

    const unsubscribe = subscribeToEventSource("/api/pipeline/progress", {
      onOpen,
      onMessage,
      onError,
    });

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
      expect(redirectToSignIn).toHaveBeenCalledTimes(1);
    });

    expect(onOpen).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    // A 401 stops the stream — no bearer retry, no reconnect loop.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("reconnects after a dropped stream and replays the latest state", async () => {
    const encoder = new TextEncoder();
    const onOpen = vi.fn();
    const onMessage = vi.fn();
    const onError = vi.fn();

    const streamOnce = (payload: string) =>
      ({
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            controller.close();
          },
        }),
      }) as Response;

    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(streamOnce('{"step":"importing"}'))
      .mockResolvedValue(streamOnce('{"step":"completed"}'));

    const unsubscribe = subscribeToEventSource("/api/pipeline/progress", {
      onOpen,
      onMessage,
      onError,
    });

    // First stream delivers "importing" then closes -> onError fires and the
    // client reconnects, picking up the replayed "completed" state.
    await vi.waitFor(
      () => {
        expect(onError).toHaveBeenCalled();
        expect(onMessage).toHaveBeenCalledWith({ step: "completed" });
      },
      { timeout: 5000 },
    );

    expect(onMessage).toHaveBeenCalledWith({ step: "importing" });
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    unsubscribe();
  });
});
