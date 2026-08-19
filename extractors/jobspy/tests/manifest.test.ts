import { describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runJobSpy: vi.fn(),
  parseJobSpyProgressLine: vi.fn(),
}));

describe("jobspy manifest", () => {
  it("forwards the runner's unreadable-item count to the pipeline", async () => {
    // The manifest is the ONLY path from the runner to the pipeline; a wrapper
    // that rebuilds the result without droppedCount makes the funnel's count
    // permanently zero however well the runner counts (B35).
    const { manifest } = await import("../manifest");
    const { runJobSpy } = await import("../src/run");
    vi.mocked(runJobSpy).mockResolvedValue({
      success: true,
      jobs: [],
      droppedCount: 7,
    });

    const result = await manifest.run({
      source: "jobspy",
      selectedSources: ["indeed", "linkedin"],
      settings: {},
      searchTerms: ["backend engineer"],
      selectedCountry: "germany",
    });

    expect(result.droppedCount).toBe(7);
  });
});
