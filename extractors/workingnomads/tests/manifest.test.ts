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
        // A LEFTOVER stored value: the `searchCities` field and its `city`
        // mapping are gone from the schema, but `resolveSourceContextSettings`
        // copies every stored config key into settings regardless of schema, so
        // an existing source_configs row still carries it. It must not be able
        // to resurrect the city filtering B71 removed.
        searchCities: "Berlin",
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "germany",
    });

    expect(runWorkingNomadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
        workplaceTypes: ["remote", "hybrid"],
        selectedCountry: "germany",
      }),
    );
    // objectContaining cannot prove a key is ABSENT, and toHaveBeenCalledWith
    // uses toEqual semantics that ignore undefined-valued keys — so assert the
    // key set directly.
    expect(
      Object.keys(runWorkingNomadsMock.mock.calls[0]?.[0] ?? {}),
    ).not.toContain("locations");
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
