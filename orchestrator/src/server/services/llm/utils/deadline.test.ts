import { describe, expect, it, vi } from "vitest";
import { deadlineErrorMessage, startDeadline } from "./deadline";

describe("startDeadline", () => {
  it("aborts once the timeout elapses and says so", async () => {
    const deadline = startDeadline({ timeoutMs: 10 });

    expect(deadline.timedOut()).toBe(false);
    await vi.waitFor(() => expect(deadline.signal.aborted).toBe(true));
    expect(deadline.timedOut()).toBe(true);

    deadline.dispose();
  });

  it("does not report a caller's abort as a timeout", async () => {
    // The distinction the whole helper exists for: a user cancelling a
    // ghostwriter run must never surface as "the provider timed out".
    const controller = new AbortController();
    const deadline = startDeadline({
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    controller.abort();

    await vi.waitFor(() => expect(deadline.signal.aborted).toBe(true));
    expect(deadline.timedOut()).toBe(false);

    deadline.dispose();
  });

  it("starts aborted when the caller's signal already was", () => {
    const controller = new AbortController();
    controller.abort();

    const deadline = startDeadline({
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut()).toBe(false);

    deadline.dispose();
  });

  it("stops the clock on dispose", async () => {
    const deadline = startDeadline({ timeoutMs: 10 });
    deadline.dispose();

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.timedOut()).toBe(false);
  });

  it("names the setting that raises the ceiling", () => {
    const message = deadlineErrorMessage({
      timeoutMs: 300_000,
      provider: "openrouter",
    });

    expect(message).toContain("300000ms");
    expect(message).toContain("openrouter");
    expect(message.toLowerCase()).toContain("timed out");
  });
});
