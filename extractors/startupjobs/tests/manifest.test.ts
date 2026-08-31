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

  it("forwards salvaged jobs and the dropped count on a FAILED run", async () => {
    const { manifest } = await import("../src/manifest");
    const { runStartupJobs } = await import("../src/run");
    vi.mocked(runStartupJobs).mockResolvedValue({
      success: false,
      jobs: [
        {
          source: "startupjobs",
          title: "Engineer",
          employer: "Acme",
          jobUrl: "https://startup.jobs/1",
        },
      ],
      droppedCount: 3,
      error: "startup.jobs is rate limiting this machine (HTTP 429)",
    });

    const result = await manifest.run({
      source: "startupjobs",
      selectedSources: ["startupjobs"],
      settings: {},
      searchTerms: ["backend engineer"],
      selectedCountry: "czechia",
    });

    // The runner salvages; this wrapper is the only path to the pipeline, so
    // returning jobs: [] here would discard the salvage a second time.
    expect(result.success).toBe(false);
    expect(result.jobs).toHaveLength(1);
    expect(result.droppedCount).toBe(3);
    expect(result.error).toMatch(/rate limiting/);
  });

  it("defaults detail concurrency to 1 rather than the package's 8", async () => {
    const { manifest } = await import("../src/manifest");
    const { runStartupJobs } = await import("../src/run");
    const runStartupJobsMock = vi.mocked(runStartupJobs);
    runStartupJobsMock.mockResolvedValue({ success: true, jobs: [] });

    // No detail_concurrency in settings: this is the shape extractor-health.ts
    // uses, since it calls manifest.run directly and never applies the config
    // schema's defaults.
    await manifest.run({
      source: "startupjobs",
      selectedSources: ["startupjobs"],
      settings: {},
      searchTerms: ["software engineer"],
      selectedCountry: "united kingdom",
    });

    expect(runStartupJobsMock).toHaveBeenCalledWith(
      expect.objectContaining({ detailConcurrency: 1 }),
    );
  });

  it("passes a configured detail concurrency through, ignoring garbage", async () => {
    const { manifest } = await import("../src/manifest");
    const { runStartupJobs } = await import("../src/run");
    const runStartupJobsMock = vi.mocked(runStartupJobs);
    runStartupJobsMock.mockResolvedValue({ success: true, jobs: [] });

    const call = async (detail_concurrency: string) => {
      runStartupJobsMock.mockClear();
      await manifest.run({
        source: "startupjobs",
        selectedSources: ["startupjobs"],
        settings: { detail_concurrency },
        searchTerms: ["software engineer"],
        selectedCountry: "united kingdom",
      });
      return runStartupJobsMock.mock.calls.at(-1)?.[0]?.detailConcurrency;
    };

    expect(await call("4")).toBe(4);
    // Belt-and-braces rather than a stall guard: the package clamps to 1..16
    // itself, so this only keeps the value we pass honest.
    expect(await call("0")).toBe(1);
    expect(await call("not a number")).toBe(1);
  });

  it("exposes detail concurrency as a config field defaulting to 1", async () => {
    const { manifest } = await import("../src/manifest");
    const field = manifest.configSchema?.fields.find(
      (candidate) => candidate.key === "detail_concurrency",
    );

    expect(field).toBeDefined();
    expect(field?.default).toBe("1");
  });
});
