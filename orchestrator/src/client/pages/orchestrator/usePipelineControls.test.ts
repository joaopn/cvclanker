import * as api from "@client/api";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePipelineControls } from "./usePipelineControls";

vi.mock("@client/api", () => ({
  runPipeline: vi.fn(),
  cancelPipeline: vi.fn(),
}));

vi.mock("@client/lib/toast", () => ({
  toast: {
    message: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function renderControls() {
  return renderHook(() =>
    usePipelineControls({
      isPipelineRunning: false,
      setIsPipelineRunning: vi.fn(),
      pipelineTerminalEvent: null,
    }),
  );
}

describe("usePipelineControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.runPipeline).mockResolvedValue({
      message: "Pipeline started",
    } as never);
  });

  it("re-runs one extractor against the Search Profile it was fired from", async () => {
    const { result } = renderControls();

    await act(async () => {
      await result.current.handleRerunSource("linkedin", "profile-1");
    });

    expect(api.runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-1",
        sources: ["linkedin"],
        // The other side is emptied deliberately, to scope the run to this one.
        providerInstanceIds: [],
        partial: true,
      }),
    );
  });

  it("re-runs one provider instance against that same profile", async () => {
    const { result } = renderControls();

    await act(async () => {
      await result.current.handleRerunSource("apify:inst-1", "profile-1");
    });

    expect(api.runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "profile-1",
        sources: [],
        providerInstanceIds: ["inst-1"],
        partial: true,
      }),
    );
  });

  it("falls back to the default profile when the banner has no pages", async () => {
    const { result } = renderControls();

    await act(async () => {
      await result.current.handleRerunSource("linkedin");
    });

    expect(api.runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: undefined, sources: ["linkedin"] }),
    );
  });
});
