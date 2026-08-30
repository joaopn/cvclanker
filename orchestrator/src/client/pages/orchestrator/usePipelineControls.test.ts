import * as api from "@client/api";
import { toast } from "@client/lib/toast";
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

function renderControls(args: { isPipelineRunning?: boolean } = {}) {
  return renderHook(() =>
    usePipelineControls({
      isPipelineRunning: args.isPipelineRunning ?? false,
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

  /**
   * The menu's whole point on a chain: without this the selection is built,
   * validated and then dropped one layer above the API call, so unticking a
   * source does nothing and every profile runs its full pin set.
   */
  it("carries the run menu's scoping into a multi-profile chain", async () => {
    const { result } = renderControls();

    await act(async () => {
      await result.current.runPipelineNow(["p1", "p2"], {
        sources: ["linkedin"],
        providerInstanceIds: ["inst-1"],
        scrapeWindowDays: 3,
        scrapeSinceLastRun: false,
      });
    });

    expect(api.runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        profileIds: ["p1", "p2"],
        sources: ["linkedin"],
        providerInstanceIds: ["inst-1"],
        scrapeWindowDays: 3,
        scrapeSinceLastRun: false,
      }),
    );
  });

  /**
   * Same failure as the chain-scoping test above, and it happened again:
   * `startPipelineRun` re-projects its config field by field into the API
   * call, and a property arriving through `...overrides` is invisible to tsc,
   * so a new override is accepted and dropped with every layer green. Asserted
   * on BOTH arms because they build the request separately.
   */
  it.each<[string, string[]]>([
    ["single profile", ["p1"]],
    ["chain", ["p1", "p2"]],
  ])("carries the live-status choice into a run (%s)", async (_name, ids) => {
    const { result } = renderControls();

    await act(async () => {
      await result.current.runPipelineNow(ids, {
        refreshLiveStatus: true,
      });
    });

    const body = vi.mocked(api.runPipeline).mock.calls.at(-1)?.[0];
    // Read off the actual request rather than matched loosely: the bug this
    // guards produces an ABSENT key, and the server reads absent as "use the
    // standing setting" — i.e. the opposite of what the user ticked.
    expect(body).toBeDefined();
    expect(body?.refreshLiveStatus).toBe(true);
  });

  it("reports the legs the server actually queued, not the ones asked for", async () => {
    vi.mocked(api.runPipeline).mockResolvedValue({
      message: "Pipeline started",
      profileCount: 1,
    } as never);
    const { result } = renderControls();

    await act(async () => {
      await result.current.runPipelineNow(["p1", "p2", "p3"], {
        sources: ["linkedin"],
      });
    });

    // A leg the filter empties is dropped server-side, so the requested count
    // would over-report what ran.
    expect(toast.message).toHaveBeenCalledWith(
      "Pipeline started",
      expect.objectContaining({
        description: expect.not.stringContaining("3 profiles"),
      }),
    );
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

  describe("handleRerunSources", () => {
    it("re-runs every failed source in one partial run, one source at a time", async () => {
      const { result } = renderControls();

      await act(async () => {
        await result.current.handleRerunSources(
          ["linkedin", "apify:inst-1", "indeed"],
          "profile-1",
        );
      });

      expect(api.runPipeline).toHaveBeenCalledTimes(1);
      expect(api.runPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "profile-1",
          sources: ["linkedin", "indeed"],
          providerInstanceIds: ["inst-1"],
          partial: true,
          discoveryConcurrency: 1,
        }),
      );
    });

    it("names the sources the server skipped as disabled", async () => {
      vi.mocked(api.runPipeline).mockResolvedValue({
        message: "Pipeline started",
        skippedDisabledSources: ["indeed"],
      } as never);
      const { result } = renderControls();

      await act(async () => {
        await result.current.handleRerunSources(["linkedin", "indeed"]);
      });

      expect(toast.message).toHaveBeenCalledWith(
        "Pipeline started",
        expect.objectContaining({
          description: expect.stringContaining(
            "Skipped, disabled or removed on the Sources page: indeed",
          ),
        }),
      );
    });

    it("starts nothing while a run is already in flight", async () => {
      const { result } = renderControls({ isPipelineRunning: true });

      await act(async () => {
        await result.current.handleRerunSources(["linkedin"]);
      });

      expect(api.runPipeline).not.toHaveBeenCalled();
    });
  });
});
