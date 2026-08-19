import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runWorkingNomads: vi.fn(),
}));

describe("workingnomads manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards automatic-run settings to the runner", async () => {
    const { manifest } = await import("../src/manifest");
    const { runWorkingNomads } = await import("../src/run");
    const runWorkingNomadsMock = vi.mocked(runWorkingNomads);
    runWorkingNomadsMock.mockResolvedValue({
      success: true,
      jobs: [],
    });

    await manifest.run({
      source: "workingnomads",
      selectedSources: ["workingnomads"],
      settings: {
        max_jobs_per_term: "70",
        workplaceTypes: '["remote","hybrid"]',
        searchCities: "Berlin",
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "germany",
    });

    expect(runWorkingNomadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
        workplaceTypes: ["remote", "hybrid"],
        locations: ["Berlin"],
        selectedCountry: "germany",
      }),
    );
  });

  it("forwards the runner's unreadable-item count to the pipeline", async () => {
    // This wrapper is the ONLY path from the runner to the pipeline, so
    // re-wrapping the result without droppedCount makes the funnel's count
    // permanently zero however well the runner counts (B35).
    const { manifest } = await import("../src/manifest");
    const { runWorkingNomads } = await import("../src/run");
    vi.mocked(runWorkingNomads).mockResolvedValue({
      success: true,
      jobs: [],
      droppedCount: 4,
    });

    const result = await manifest.run({
      source: "workingnomads",
      selectedSources: ["workingnomads"],
      settings: {},
      searchTerms: ["backend engineer"],
      selectedCountry: "germany",
    });

    expect(result.droppedCount).toBe(4);
  });
});
