import { describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runHiringCafe: vi.fn(),
}));

describe("hiringcafe manifest", () => {
  it("forwards the runner's unreadable-item count to the pipeline", async () => {
    // The manifest is the ONLY path from the runner to the pipeline; a wrapper
    // that rebuilds the result without droppedCount makes the funnel's count
    // permanently zero however well the runner counts (B35).
    const { manifest } = await import("../manifest");
    const { runHiringCafe } = await import("../src/run");
    vi.mocked(runHiringCafe).mockResolvedValue({
      success: true,
      jobs: [],
      droppedCount: 3,
    });

    const result = await manifest.run({
      source: "hiringcafe",
      selectedSources: ["hiringcafe"],
      settings: {},
      searchTerms: ["backend engineer"],
      selectedCountry: "austria",
    });

    expect(result.droppedCount).toBe(3);
  });
});
