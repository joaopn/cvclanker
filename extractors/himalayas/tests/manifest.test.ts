import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runHimalayas: vi.fn(),
}));

describe("himalayas manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards automatic-run settings to the runner", async () => {
    const { manifest } = await import("../src/manifest");
    const { runHimalayas } = await import("../src/run");
    const runMock = vi.mocked(runHimalayas);
    runMock.mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "himalayas",
      selectedSources: ["himalayas"],
      settings: {
        max_jobs_per_term: "70",
        workplaceTypes: '["remote"]',
        max_age_days: "3",
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "portugal",
    });

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        searchTerms: ["backend engineer"],
        workplaceTypes: ["remote"],
        maxJobs: 70,
        maxAgeDays: 3,
      }),
    );
  });

  it("tolerates a malformed stored workplaceTypes value", async () => {
    const { manifest } = await import("../src/manifest");
    const { runHimalayas } = await import("../src/run");
    const runMock = vi.mocked(runHimalayas);
    runMock.mockResolvedValue({ success: true, jobs: [] });

    const result = await manifest.run({
      source: "himalayas",
      selectedSources: ["himalayas"],
      settings: { workplaceTypes: "not json" },
      searchTerms: [],
      selectedCountry: "",
    });

    expect(result.success).toBe(true);
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({ workplaceTypes: undefined }),
    );
  });

  it("forwards the runner's unreadable-item count to the pipeline", async () => {
    // This wrapper is the ONLY path from the runner to the pipeline, so
    // re-wrapping the result without droppedCount makes the funnel's count
    // permanently zero however well the runner counts (B35).
    const { manifest } = await import("../src/manifest");
    const { runHimalayas } = await import("../src/run");
    vi.mocked(runHimalayas).mockResolvedValue({
      success: true,
      jobs: [],
      droppedCount: 4,
    });

    const result = await manifest.run({
      source: "himalayas",
      selectedSources: ["himalayas"],
      settings: {},
      searchTerms: [],
      selectedCountry: "",
    });

    expect(result.droppedCount).toBe(4);
  });

  it("declares the config fields its global mappings target", async () => {
    // The registry boot-fails on a mapping whose sourceField has no field.
    const { manifest } = await import("../src/manifest");
    const fieldKeys = new Set(
      (manifest.configSchema?.fields ?? []).map((field) => field.key),
    );
    for (const mapping of manifest.configSchema?.globalMappings ?? []) {
      expect(fieldKeys.has(mapping.sourceField)).toBe(true);
    }
    expect(manifest.capabilities?.joinedTerms).toBe(true);
  });
});
