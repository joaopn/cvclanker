import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runStartupJobs: vi.fn(),
}));

describe("startupjobs manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes max_jobs_per_term through to the runner", async () => {
    const { manifest } = await import("../src/manifest");
    const { runStartupJobs } = await import("../src/run");
    const runStartupJobsMock = vi.mocked(runStartupJobs);
    runStartupJobsMock.mockResolvedValue({
      success: true,
      jobs: [],
    });

    await manifest.run({
      source: "startupjobs",
      selectedSources: ["startupjobs"],
      settings: {
        max_jobs_per_term: "70",
      },
      searchTerms: ["software engineer"],
      selectedCountry: "united kingdom",
    });

    expect(runStartupJobsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobsPerTerm: 70,
      }),
    );
  });

  it("forwards workplace types to the runner", async () => {
    const { manifest } = await import("../src/manifest");
    const { runStartupJobs } = await import("../src/run");
    const runStartupJobsMock = vi.mocked(runStartupJobs);
    runStartupJobsMock.mockResolvedValue({
      success: true,
      jobs: [],
    });

    await manifest.run({
      source: "startupjobs",
      selectedSources: ["startupjobs"],
      settings: {
        workplaceTypes: '["remote","onsite"]',
      },
      searchTerms: ["software engineer"],
      selectedCountry: "united kingdom",
    });

    expect(runStartupJobsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workplaceTypes: ["remote", "onsite"],
      }),
    );
  });

  it("forwards the runner's unreadable-item count to the pipeline", async () => {
    const { manifest } = await import("../src/manifest");
    const { runStartupJobs } = await import("../src/run");
    vi.mocked(runStartupJobs).mockResolvedValue({
      success: true,
      jobs: [],
      droppedCount: 2,
    });

    const result = await manifest.run({
      source: "startupjobs",
      selectedSources: ["startupjobs"],
      settings: {},
      searchTerms: ["backend engineer"],
      selectedCountry: "czechia",
    });

    expect(result.droppedCount).toBe(2);
  });
});
