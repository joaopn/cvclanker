// @vitest-environment node
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
