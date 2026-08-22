import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", async (importActual) => {
  const actual = await importActual<typeof import("../src/run")>();
  return { ...actual, runJobicy: vi.fn() };
});

describe("jobicy manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards automatic-run settings to the runner", async () => {
    const { manifest } = await import("../src/manifest");
    const { runJobicy } = await import("../src/run");
    const runMock = vi.mocked(runJobicy);
    runMock.mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "jobicy",
      selectedSources: ["jobicy"],
      settings: {
        max_jobs_per_term: "70",
        workplaceTypes: '["remote"]',
        max_age_days: "3",
        geo: "united kingdom",
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "portugal",
    });

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        searchTerms: ["backend engineer"],
        workplaceTypes: ["remote"],
        maxJobsPerTerm: 70,
        maxAgeDays: 3,
        // The explicit geo field is the only geo source.
        selectedCountry: "united kingdom",
      }),
    );
  });

  it("sends no geo filter when the field is blank — a remote profile is a blacklist", async () => {
    const { manifest } = await import("../src/manifest");
    const { runJobicy } = await import("../src/run");
    vi.mocked(runJobicy).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "jobicy",
      selectedSources: ["jobicy"],
      settings: {},
      searchTerms: [],
      selectedCountry: "portugal",
    });

    expect(vi.mocked(runJobicy)).toHaveBeenCalledWith(
      expect.objectContaining({ selectedCountry: undefined }),
    );
  });

  it("tolerates a malformed stored workplaceTypes value", async () => {
    const { manifest } = await import("../src/manifest");
    const { runJobicy } = await import("../src/run");
    vi.mocked(runJobicy).mockResolvedValue({ success: true, jobs: [] });

    const result = await manifest.run({
      source: "jobicy",
      selectedSources: ["jobicy"],
      settings: { workplaceTypes: "not json" },
      searchTerms: [],
      selectedCountry: "",
    });

    expect(result.success).toBe(true);
    expect(vi.mocked(runJobicy)).toHaveBeenCalledWith(
      expect.objectContaining({ workplaceTypes: undefined }),
    );
  });

  it("forwards the runner's unreadable-item count to the pipeline", async () => {
    // This wrapper is the ONLY path from the runner to the pipeline, so
    // re-wrapping the result without droppedCount makes the funnel's count
    // permanently zero however well the runner counts (B35).
    const { manifest } = await import("../src/manifest");
    const { runJobicy } = await import("../src/run");
    vi.mocked(runJobicy).mockResolvedValue({
      success: true,
      jobs: [],
      droppedCount: 4,
    });

    const result = await manifest.run({
      source: "jobicy",
      selectedSources: ["jobicy"],
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
    // Terms are one request each — max_jobs_per_term stays per-term.
    expect(manifest.capabilities?.joinedTerms).toBeUndefined();
  });
});
