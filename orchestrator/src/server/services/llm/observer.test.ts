// @vitest-environment node
import type { LlmCallRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { llmCallObserver } from "./observer";

function latest(id: string) {
  const record = llmCallObserver.snapshot().find((entry) => entry.id === id);
  if (!record) throw new Error("record not found in snapshot");
  return record;
}

function registerCall() {
  const seen: string[] = llmCallObserver.snapshot().map((entry) => entry.id);
  const handle = llmCallObserver.register({
    label: "score job",
    subject: "Senior Consultant @ SYSTRA",
    model: "claude-opus-5",
  });
  const record = llmCallObserver
    .snapshot()
    .find((entry) => !seen.includes(entry.id));
  if (!record) throw new Error("registered record missing from snapshot");
  return { handle, id: record.id };
}

/**
 * The window is oldest-first, so a long call gets pushed towards its edge
 * while shorter ones churn past it. Under two-step classification every job
 * books two records, so this is the ordinary case, not a corner one.
 */
describe("llmCallObserver record window", () => {
  it("reports a running call's completion even after the window overflows", () => {
    const seen = new Map<string, string>();
    const onUpdate = (call: LlmCallRecord) => seen.set(call.id, call.status);
    llmCallObserver.on("update", onUpdate);

    try {
      const slow = registerCall();
      for (let i = 0; i < 60; i += 1) {
        registerCall().handle.succeed();
      }
      slow.handle.succeed({ promptTokens: 50, completionTokens: 5 });

      expect(seen.get(slow.id)).toBe("succeeded");
    } finally {
      llmCallObserver.off("update", onUpdate);
    }
  });

  it("keeps an unfinished call in the snapshot rather than dropping it", () => {
    const slow = registerCall();
    for (let i = 0; i < 60; i += 1) {
      registerCall().handle.succeed();
    }

    expect(latest(slow.id).status).toBe("running");
  });
});

describe("llmCallObserver token totals", () => {
  it("leaves totalTokens null while the call is running", () => {
    const { id } = registerCall();
    expect(latest(id).status).toBe("running");
    expect(latest(id).totalTokens).toBeNull();
  });

  it("sums the provider-reported usage on success", () => {
    const { handle, id } = registerCall();
    handle.succeed({ promptTokens: 1234, completionTokens: 56 });
    expect(latest(id).status).toBe("succeeded");
    expect(latest(id).totalTokens).toBe(1290);
  });

  it("keeps totalTokens null when the provider reports no usage", () => {
    const { handle: noUsage, id: noUsageId } = registerCall();
    noUsage.succeed({ promptTokens: null, completionTokens: null });
    expect(latest(noUsageId).totalTokens).toBeNull();

    const { handle: omitted, id: omittedId } = registerCall();
    omitted.succeed();
    expect(latest(omittedId).totalTokens).toBeNull();
  });

  it("keeps totalTokens null on failure", () => {
    const { handle, id } = registerCall();
    handle.fail("boom");
    expect(latest(id).status).toBe("failed");
    expect(latest(id).totalTokens).toBeNull();
  });
});
