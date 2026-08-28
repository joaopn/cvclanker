import { createLocationIntentFromLegacyInputs } from "@shared/location-domain.js";
import type { PipelineConfig } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProgress, resetProgress } from "../progress";
import { getRunJobs, resetRunJobCapture } from "../run-job-capture";
import { discoverJobsStep } from "./discover-jobs";

vi.mock("@server/repositories/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("@server/repositories/jobs", () => ({
  getAllJobUrls: vi.fn().mockResolvedValue([]),
}));

vi.mock("@server/repositories/source-configs", () => ({
  getAllSourceConfigs: vi.fn().mockResolvedValue([
    {
      extractorId: "jobspy",
      enabled: true,
      config: {},
      mappings: {},
      updatedAt: "",
    },
    {
      extractorId: "hiringcafe",
      enabled: true,
      config: {},
      mappings: {},
      updatedAt: "",
    },
    {
      extractorId: "startupjobs",
      enabled: true,
      config: {},
      mappings: {},
      updatedAt: "",
    },
    {
      extractorId: "workingnomads",
      enabled: true,
      config: {},
      mappings: {},
      updatedAt: "",
    },
  ]),
}));

vi.mock("@server/repositories/provider-instances", () => ({
  getEnabledProviderInstances: vi.fn().mockResolvedValue([]),
}));

vi.mock("@server/extractors/registry", () => ({
  getExtractorRegistry: vi.fn(),
}));

vi.mock("@server/repositories/source-scrape-watermarks", () => ({
  getScrapeWatermarks: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("@server/providers", () => ({
  getProvider: vi.fn(),
}));

const baseConfig: PipelineConfig = {
  topN: 10,
  minSuitabilityCategory: "good_fit",
  sources: ["indeed", "linkedin", "hiringcafe"],
  outputDir: "./tmp",
  enableCrawling: true,
  enableScoring: true,
  enableImporting: true,
  enableAutoTailoring: true,
  searchTerms: ["engineer"],
  locationIntent: createLocationIntentFromLegacyInputs({
    selectedCountry: "united kingdom",
  }),
};

describe("discoverJobsStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProgress();
  });

  it("aggregates source errors for enabled sources", async () => {
    const registryModule = await import("@server/extractors/registry");

    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "linkedin",
            title: "Engineer",
            employer: "ACME",
            jobUrl: "https://example.com/job",
            location: "London, United Kingdom",
            locationEvidence: {
              location: "London, United Kingdom",
              country: "united kingdom",
              city: "London",
              source: "location",
            },
          },
        ],
      }),
    };
    const ukvisaManifest = {
      id: "hiringcafe",
      displayName: "Hiring Cafe",
      providesSources: ["hiringcafe"],
      run: vi.fn().mockResolvedValue({
        success: false,
        jobs: [],
        error: "login failed",
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([
        ["jobspy", jobspyManifest as any],
        ["hiringcafe", ukvisaManifest as any],
      ]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
        ["hiringcafe", ukvisaManifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor", "hiringcafe"],
    } as any);

    const result = await discoverJobsStep({ mergedConfig: baseConfig });

    expect(result.discoveredJobs).toHaveLength(1);
    expect(result.sourceErrors).toEqual([
      "Hiring Cafe: login failed (sources: hiringcafe)",
    ]);
    expect(jobspyManifest.run).toHaveBeenCalledWith(
      expect.objectContaining({ selectedSources: ["indeed", "linkedin"] }),
    );
  });

  it("imports a failed instance's salvaged rows, marks the row failed, and holds its watermark", async () => {
    const providerInstances = await import(
      "@server/repositories/provider-instances"
    );
    const providersModule = await import("@server/providers");
    const salvagedJob = {
      source: "apify:inst-1",
      title: "Engineer",
      employer: "ACME",
      jobUrl: "https://example.com/salvaged",
      location: "London, United Kingdom",
      locationEvidence: {
        location: "London, United Kingdom",
        country: "united kingdom",
        city: "London",
        source: "location",
      },
    };
    // *Once so the overrides drain after this test instead of leaking into
    // the rest of the file (clearAllMocks keeps implementations).
    vi.mocked(
      providerInstances.getEnabledProviderInstances,
    ).mockResolvedValueOnce([
      {
        id: "inst-1",
        providerId: "apify",
        actorRef: "acme/actor",
        label: "Acme actor",
        maxJobs: null,
        maxAgeDays: null,
      },
    ] as never);
    vi.mocked(providersModule.getProvider).mockReturnValueOnce({
      id: "apify",
      displayName: "Apify",
      templates: [],
      run: vi.fn().mockResolvedValue({
        success: false,
        jobs: [salvagedJob],
        error:
          "Actor run timed out after scraping 3 item(s); kept the 1 job(s) mapped from them",
        droppedCount: 2,
      }),
    } as never);

    const result = await discoverJobsStep({
      mergedConfig: { ...baseConfig, sources: [] },
    });

    // The paid-for row imports like any other…
    expect(result.discoveredJobs.map((job) => job.jobUrl)).toEqual([
      "https://example.com/salvaged",
    ]);
    // …the source still reads as failed…
    expect(result.sourceErrors).toEqual([
      "Acme actor: Actor run timed out after scraping 3 item(s); kept the 1 job(s) mapped from them",
    ]);
    // …and its watermark does not advance over the window it missed.
    expect(result.scrapedSources.map((mark) => mark.sourceKey)).not.toContain(
      "apify:inst-1",
    );

    const row = getProgress().sourceStats.find(
      (candidate) => candidate.id === "apify:inst-1",
    );
    expect(row?.status).toBe("failed");
    expect(row?.jobsScraped).toBe(1);
    expect(row?.jobsUnmappable).toBe(2);
    expect(row?.error).toMatch(/timed out/);
    expect(
      getRunJobs("apify:inst-1", "scraped").map((job) => job.jobUrl),
    ).toEqual(["https://example.com/salvaged"]);
  });

  it("crawls one source at a time when the run overrides discoveryConcurrency to 1", async () => {
    const registryModule = await import("@server/extractors/registry");

    let finishJobspy: () => void = () => {};
    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finishJobspy = () => resolve({ success: true, jobs: [] });
          }),
      ),
    };
    const hiringcafeManifest = {
      id: "hiringcafe",
      displayName: "Hiring Cafe",
      providesSources: ["hiringcafe"],
      run: vi.fn().mockResolvedValue({ success: true, jobs: [] }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([
        ["jobspy", jobspyManifest as any],
        ["hiringcafe", hiringcafeManifest as any],
      ]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
        ["hiringcafe", hiringcafeManifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor", "hiringcafe"],
    } as any);

    const step = discoverJobsStep({
      mergedConfig: { ...baseConfig, discoveryConcurrency: 1 },
    });

    try {
      // The setting's default pool (3) would have started both by now.
      await vi.waitFor(() => expect(jobspyManifest.run).toHaveBeenCalled());
      expect(hiringcafeManifest.run).not.toHaveBeenCalled();
    } finally {
      finishJobspy();
    }
    const result = await step;

    expect(hiringcafeManifest.run).toHaveBeenCalledTimes(1);
    expect(result.sourceErrors).toEqual([]);
  });

  it("throws when all enabled sources fail", async () => {
    const registryModule = await import("@server/extractors/registry");

    const ukvisaManifest = {
      id: "hiringcafe",
      displayName: "Hiring Cafe",
      providesSources: ["hiringcafe"],
      run: vi.fn().mockResolvedValue({
        success: false,
        jobs: [],
        error: "boom",
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["hiringcafe", ukvisaManifest as any]]),
      manifestBySource: new Map([["hiringcafe", ukvisaManifest as any]]),
      availableSources: ["hiringcafe"],
    } as any);

    await expect(
      discoverJobsStep({
        mergedConfig: {
          ...baseConfig,
          sources: ["hiringcafe"],
        },
      }),
    ).rejects.toThrow(
      "All sources failed: Hiring Cafe: boom (sources: hiringcafe)",
    );
  });

  it("throws when all requested sources are incompatible for country", async () => {
    const registryModule = await import("@server/extractors/registry");

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map(),
      manifestBySource: new Map(),
      availableSources: [],
    } as any);

    // Glassdoor is the only kept source with country restrictions; pick a
    // country it does not support so the country-compat filter rejects it.
    await expect(
      discoverJobsStep({
        mergedConfig: {
          ...baseConfig,
          sources: ["glassdoor"],
          locationIntent: createLocationIntentFromLegacyInputs({
            selectedCountry: "croatia",
          }),
        },
      }),
    ).rejects.toThrow("No compatible sources for selected country: Croatia");
  });

  it("does not throw when no sources are requested", async () => {
    const registryModule = await import("@server/extractors/registry");

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map(),
      manifestBySource: new Map(),
      availableSources: [],
    } as any);

    const result = await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: [],
        locationIntent: createLocationIntentFromLegacyInputs({
          selectedCountry: "united states",
        }),
      },
    });

    expect(result.discoveredJobs).toEqual([]);
    expect(result.sourceErrors).toEqual([]);
  });

  it("drops discovered jobs when employer matches blocked company keywords", async () => {
    const registryModule = await import("@server/extractors/registry");

    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "linkedin",
            title: "Engineer",
            employer: "Acme Staffing",
            jobUrl: "https://example.com/job-1",
          },
          {
            source: "linkedin",
            title: "Engineer II",
            employer: "Contoso",
            jobUrl: "https://example.com/job-2",
          },
        ],
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["jobspy", jobspyManifest as any]]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor"],
    } as any);

    const result = await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: ["linkedin"],
        blockedCompanyKeywords: ["recruit", "staffing"],
        locationIntent: createLocationIntentFromLegacyInputs({}),
      },
    });

    expect(result.discoveredJobs).toHaveLength(1);
    expect(result.discoveredJobs[0]?.employer).toBe("Contoso");
  });

  it("applies shared city filtering for sources without native city filtering", async () => {
    const registryModule = await import("@server/extractors/registry");

    const workingnomadsManifest = {
      id: "workingnomads",
      displayName: "Working Nomads",
      providesSources: ["workingnomads"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "workingnomads",
            title: "Engineer - Leeds",
            employer: "ACME",
            location: "Leeds, England, UK",
            jobUrl: "https://example.com/wn-1",
          },
          {
            source: "workingnomads",
            title: "Engineer - London",
            employer: "ACME",
            location: "London, England, UK",
            jobUrl: "https://example.com/wn-2",
          },
        ],
      }),
    };
    const ukvisaManifest = {
      id: "hiringcafe",
      displayName: "Hiring Cafe",
      providesSources: ["hiringcafe"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "hiringcafe",
            title: "Developer - Leeds",
            employer: "Contoso",
            location: "Leeds, England, UK",
            jobUrl: "https://example.com/ukv-1",
          },
        ],
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([
        ["workingnomads", workingnomadsManifest as any],
        ["hiringcafe", ukvisaManifest as any],
      ]),
      manifestBySource: new Map([
        ["workingnomads", workingnomadsManifest as any],
        ["hiringcafe", ukvisaManifest as any],
      ]),
      availableSources: ["workingnomads", "hiringcafe"],
    } as any);

    const result = await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: ["workingnomads", "hiringcafe"],
        locationIntent: createLocationIntentFromLegacyInputs({
          selectedCountry: "united kingdom",
          searchCities: "Leeds",
        }),
      },
    });

    expect(result.discoveredJobs).toHaveLength(2);
    expect(
      result.discoveredJobs.every((job) => job.location?.includes("Leeds")),
    ).toBe(true);
  });

  it("drops discovered jobs outside the selected country when no cities are set", async () => {
    const registryModule = await import("@server/extractors/registry");

    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "linkedin",
            title: "Engineer - Zagreb",
            employer: "ACME Croatia",
            location: "Zagreb, Croatia",
            jobUrl: "https://example.com/hr-1",
          },
          {
            source: "linkedin",
            title: "Engineer - Bengaluru",
            employer: "ACME India",
            location: "Bengaluru, Karnataka, India",
            jobUrl: "https://example.com/in-1",
          },
          {
            source: "linkedin",
            title: "Engineer - Unknown",
            employer: "Unknown Co",
            location: null,
            jobUrl: "https://example.com/unknown-1",
          },
        ],
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["jobspy", jobspyManifest as any]]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor"],
    } as any);

    const result = await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: ["linkedin"],
        locationIntent: createLocationIntentFromLegacyInputs({
          selectedCountry: "croatia",
        }),
      },
    });

    expect(result.discoveredJobs).toHaveLength(1);
    expect(result.discoveredJobs[0]?.location).toBe("Zagreb, Croatia");
  });

  it("captures which location check rejected each job", async () => {
    const registryModule = await import("@server/extractors/registry");
    resetRunJobCapture();

    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "linkedin",
            title: "Engineer - Toronto",
            employer: "ACME Canada",
            location: "Toronto, Ontario, Canada",
            jobUrl: "https://example.com/ca-1",
          },
          {
            source: "linkedin",
            title: "Engineer - Leeds",
            employer: "ACME UK",
            location: "Leeds, England, United Kingdom",
            jobUrl: "https://example.com/uk-1",
          },
        ],
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["jobspy", jobspyManifest as any]]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor"],
    } as any);

    const result = await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: ["linkedin"],
        locationIntent: createLocationIntentFromLegacyInputs({
          selectedCountry: "united kingdom",
          searchCities: "London",
        }),
      },
    });

    expect(result.discoveredJobs).toHaveLength(0);
    const rejected = getRunJobs("linkedin", "rejected");
    expect(rejected.map((job) => [job.title, job.reason]).sort()).toEqual([
      [
        "Engineer - Leeds",
        "location mismatch: in United Kingdom, but not in a selected city",
      ],
      ["Engineer - Toronto", "location mismatch: outside United Kingdom"],
    ]);
  });

  it("keeps jobs that only expose structured location evidence", async () => {
    const registryModule = await import("@server/extractors/registry");

    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "linkedin",
            title: "Engineer - Zagreb",
            employer: "ACME Croatia",
            location: null,
            locationEvidence: {
              location: "Zagreb, Croatia",
              country: "croatia",
            },
            jobUrl: "https://example.com/hr-1",
          },
        ],
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["jobspy", jobspyManifest as any]]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor"],
    } as any);

    const result = await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: ["linkedin"],
        locationIntent: createLocationIntentFromLegacyInputs({
          selectedCountry: "croatia",
        }),
      },
    });

    expect(result.discoveredJobs).toHaveLength(1);
    expect(result.discoveredJobs[0]?.locationEvidence).toEqual(
      expect.objectContaining({
        location: "Zagreb, Croatia",
        country: "croatia",
      }),
    );
  });

  it("keeps remote jobs worldwide when scope allows them", async () => {
    const registryModule = await import("@server/extractors/registry");

    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "linkedin",
            title: "Engineer - Zagreb",
            employer: "ACME Croatia",
            location: "Zagreb, Croatia",
            isRemote: false,
            jobUrl: "https://example.com/hr-1",
          },
          {
            source: "linkedin",
            title: "Engineer - Anywhere",
            employer: "Remote Co",
            location: "Bengaluru, Karnataka, India",
            isRemote: true,
            jobUrl: "https://example.com/in-remote-1",
          },
        ],
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["jobspy", jobspyManifest as any]]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor"],
    } as any);

    const result = await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: ["linkedin"],
        locationIntent: createLocationIntentFromLegacyInputs({
          selectedCountry: "croatia",
          workplaceTypes: ["remote", "hybrid"],
          searchScope: "selected_plus_remote_worldwide",
        }),
      },
    });

    expect(result.discoveredJobs).toHaveLength(2);
    expect(result.discoveredJobs.map((job) => job.jobUrl)).toEqual([
      "https://example.com/hr-1",
      "https://example.com/in-remote-1",
    ]);
  });

  it("keeps country matches when strictness is flexible and city metadata disagrees", async () => {
    const registryModule = await import("@server/extractors/registry");

    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "linkedin",
            title: "Engineer - Split",
            employer: "ACME Croatia",
            location: "Split, Croatia",
            jobUrl: "https://example.com/hr-1",
          },
        ],
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["jobspy", jobspyManifest as any]]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor"],
    } as any);

    const result = await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: ["linkedin"],
        locationIntent: createLocationIntentFromLegacyInputs({
          selectedCountry: "croatia",
          searchCities: "Zagreb",
          matchStrictness: "flexible",
        }),
      },
    });

    expect(result.discoveredJobs).toHaveLength(1);
    expect(result.discoveredJobs[0]?.location).toBe("Split, Croatia");
  });

  it("surfaces a source's unmappable count on its funnel row", async () => {
    // Without this the row says "1 scraped" for a source that returned 4
    // items and could only read 1 — the other 3 leave no trace anywhere.
    const registryModule = await import("@server/extractors/registry");

    const manifest = {
      id: "workingnomads",
      displayName: "Working Nomads",
      providesSources: ["workingnomads"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [
          {
            source: "workingnomads",
            title: "Kept",
            employer: "Acme",
            jobUrl: "https://example.com/kept",
          },
        ],
        droppedCount: 3,
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["workingnomads", manifest as any]]),
      manifestBySource: new Map([["workingnomads", manifest as any]]),
      availableSources: ["workingnomads"],
    } as any);

    await discoverJobsStep({
      mergedConfig: { ...baseConfig, sources: ["workingnomads"] },
    });

    const row = getProgress().sourceStats.find(
      (entry) => entry.id === "workingnomads",
    );
    expect(row?.jobsScraped).toBe(1);
    expect(row?.jobsUnmappable).toBe(3);
  });

  it("keeps a fan-out extractor's unmappable count instead of losing it", async () => {
    // jobspy's task id is "jobspy" while its platforms are indeed/linkedin/
    // glassdoor, so an attribution keyed on the task's own id matches no
    // platform and silently drops the number — which is how this shipped
    // broken the first time. Reported once, never multiplied across siblings.
    const registryModule = await import("@server/extractors/registry");

    const manifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin"],
      run: vi.fn().mockResolvedValue({
        success: true,
        jobs: [],
        droppedCount: 5,
      }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["jobspy", manifest as any]]),
      manifestBySource: new Map([
        ["indeed", manifest as any],
        ["linkedin", manifest as any],
      ]),
      availableSources: ["indeed", "linkedin"],
    } as any);

    await discoverJobsStep({
      mergedConfig: { ...baseConfig, sources: ["indeed", "linkedin"] },
    });

    const rows = getProgress().sourceStats;
    const total = rows.reduce((sum, row) => sum + row.jobsUnmappable, 0);
    expect(total).toBe(5);
  });

  it("leaves unmappable at zero for a source that reports nothing dropped", async () => {
    // An extractor that omits the field must read as "dropped nothing", never
    // as "unknown" — the funnel has no way to render uncertainty.
    const registryModule = await import("@server/extractors/registry");

    const manifest = {
      id: "workingnomads",
      displayName: "Working Nomads",
      providesSources: ["workingnomads"],
      run: vi.fn().mockResolvedValue({ success: true, jobs: [] }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["workingnomads", manifest as any]]),
      manifestBySource: new Map([["workingnomads", manifest as any]]),
      availableSources: ["workingnomads"],
    } as any);

    await discoverJobsStep({
      mergedConfig: { ...baseConfig, sources: ["workingnomads"] },
    });

    expect(
      getProgress().sourceStats.find((entry) => entry.id === "workingnomads")
        ?.jobsUnmappable,
    ).toBe(0);
  });

  it("tracks source completion counters across source transitions", async () => {
    const jobsRepo = await import("@server/repositories/jobs");
    const registryModule = await import("@server/extractors/registry");

    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockResolvedValue({ success: true, jobs: [] }),
    };
    const workingnomadsManifest = {
      id: "workingnomads",
      displayName: "Working Nomads",
      providesSources: ["workingnomads"],
      run: vi.fn().mockResolvedValue({ success: true, jobs: [] }),
    };
    const ukvisaManifest = {
      id: "hiringcafe",
      displayName: "Hiring Cafe",
      providesSources: ["hiringcafe"],
      run: vi.fn().mockResolvedValue({ success: true, jobs: [] }),
    };

    vi.mocked(jobsRepo.getAllJobUrls).mockResolvedValue([
      "https://example.com/existing",
    ]);

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([
        ["jobspy", jobspyManifest as any],
        ["workingnomads", workingnomadsManifest as any],
        ["hiringcafe", ukvisaManifest as any],
      ]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
        ["workingnomads", workingnomadsManifest as any],
        ["hiringcafe", ukvisaManifest as any],
      ]),
      availableSources: [
        "indeed",
        "linkedin",
        "glassdoor",
        "workingnomads",
        "hiringcafe",
      ],
    } as any);

    await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: ["linkedin", "workingnomads", "hiringcafe"],
      },
    });

    const progress = getProgress();
    expect(progress.crawlingSourcesTotal).toBe(3);
    expect(progress.crawlingSourcesCompleted).toBe(3);
    expect(workingnomadsManifest.run).toHaveBeenCalledWith(
      expect.objectContaining({
        getExistingJobUrls: expect.any(Function),
      }),
    );

    const [{ getExistingJobUrls }] = workingnomadsManifest.run.mock
      .calls[0] as [{ getExistingJobUrls: () => Promise<string[]> }];
    await expect(getExistingJobUrls()).resolves.toEqual([
      "https://example.com/existing",
    ]);
  });

  it("passes mergedConfig.searchTerms to the extractor run", async () => {
    const registryModule = await import("@server/extractors/registry");

    const jobspyManifest = {
      id: "jobspy",
      displayName: "JobSpy",
      providesSources: ["indeed", "linkedin", "glassdoor"],
      run: vi.fn().mockResolvedValue({ success: true, jobs: [] }),
    };

    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["jobspy", jobspyManifest as any]]),
      manifestBySource: new Map([
        ["indeed", jobspyManifest as any],
        ["linkedin", jobspyManifest as any],
        ["glassdoor", jobspyManifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor"],
    } as any);

    await discoverJobsStep({
      mergedConfig: {
        ...baseConfig,
        sources: ["linkedin"],
        searchTerms: ["rust developer"],
      },
    });

    expect(jobspyManifest.run).toHaveBeenCalledWith(
      expect.objectContaining({ searchTerms: ["rust developer"] }),
    );
  });
});

describe("discoverJobsStep scrape-since-last-run window", () => {
  const jobspySchema = {
    fields: [
      { key: "max_age_days", label: "Max job age (days)", type: "number" },
    ],
    globalMappings: [
      {
        globalField: "maxAgeDays",
        sourceField: "max_age_days",
        enabledByDefault: true,
      },
    ],
  };

  const makeJobspyManifest = () => ({
    id: "jobspy",
    displayName: "JobSpy",
    providesSources: ["indeed", "linkedin", "glassdoor"],
    configSchema: jobspySchema,
    run: vi.fn().mockResolvedValue({ success: true, jobs: [] }),
  });

  async function mockRegistry(manifest: unknown) {
    const registryModule = await import("@server/extractors/registry");
    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([["jobspy", manifest as any]]),
      manifestBySource: new Map([
        ["indeed", manifest as any],
        ["linkedin", manifest as any],
        ["glassdoor", manifest as any],
      ]),
      availableSources: ["indeed", "linkedin", "glassdoor"],
    } as any);
  }

  async function setWatermarks(entries: Array<[string, string]>) {
    const watermarksModule = await import(
      "@server/repositories/source-scrape-watermarks"
    );
    vi.mocked(watermarksModule.getScrapeWatermarks).mockResolvedValue(
      new Map(entries),
    );
  }

  /**
   * A watermark `days` old, held a minute BACK OFF the day boundary.
   *
   * The window is elapsed time rounded UP, and the step reads its own
   * `Date.now()` after the fixture is built — so an exactly-N-days-old mark
   * rounds to N only while both reads land in the same millisecond, and to N+1
   * the moment anything delays the step. That is a coin flip weighted to N,
   * which is why it passed almost always and failed under load (B20, five
   * sightings). A minute of slack costs the assertions nothing and removes the
   * race: any delay short of 60s still rounds to N.
   */
  const daysAgo = (days: number) =>
    new Date(Date.now() - (days * 86_400_000 - 60_000)).toISOString();

  const withFlag = (overrides: Partial<PipelineConfig> = {}) => ({
    ...baseConfig,
    sources: ["linkedin"] as PipelineConfig["sources"],
    scrapeMaxAgeDays: 30,
    profileId: "profile-1",
    scrapeSinceLastRun: true,
    ...overrides,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    resetProgress();
    await setWatermarks([]);
  });

  it("narrows the window to the days since the source last scraped", async () => {
    const manifest = makeJobspyManifest();
    await mockRegistry(manifest);
    await setWatermarks([["jobspy", daysAgo(3)]]);

    await discoverJobsStep({ mergedConfig: withFlag() });

    expect(manifest.run).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ max_age_days: "3" }),
      }),
    );
  });

  it("keeps the configured window for a source with no watermark", async () => {
    const manifest = makeJobspyManifest();
    await mockRegistry(manifest);
    await setWatermarks([["some-other-source", daysAgo(1)]]);

    await discoverJobsStep({ mergedConfig: withFlag() });

    expect(manifest.run).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ max_age_days: "30" }),
      }),
    );
  });

  it("never widens past the configured cap", async () => {
    const manifest = makeJobspyManifest();
    await mockRegistry(manifest);
    await setWatermarks([["jobspy", daysAgo(90)]]);

    await discoverJobsStep({ mergedConfig: withFlag() });

    expect(manifest.run).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ max_age_days: "30" }),
      }),
    );
  });

  it("leaves the window alone when the flag is off", async () => {
    const manifest = makeJobspyManifest();
    await mockRegistry(manifest);
    await setWatermarks([["jobspy", daysAgo(3)]]);

    await discoverJobsStep({
      mergedConfig: withFlag({ scrapeSinceLastRun: false }),
    });

    expect(manifest.run).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ max_age_days: "30" }),
      }),
    );
  });

  it("does not read watermarks for a run with no profile", async () => {
    const manifest = makeJobspyManifest();
    await mockRegistry(manifest);
    const watermarksModule = await import(
      "@server/repositories/source-scrape-watermarks"
    );

    await discoverJobsStep({
      mergedConfig: withFlag({ profileId: undefined }),
    });

    expect(watermarksModule.getScrapeWatermarks).not.toHaveBeenCalled();
  });

  it("reports only the sources that scraped without error", async () => {
    const registryModule = await import("@server/extractors/registry");
    const jobspyManifest = makeJobspyManifest();
    // One kept job, so the "every source failed" guard does not fire first.
    jobspyManifest.run.mockResolvedValue({
      success: true,
      jobs: [
        {
          source: "linkedin",
          title: "Engineer",
          employer: "ACME",
          jobUrl: "https://example.com/job",
          location: "London, United Kingdom",
          locationEvidence: {
            location: "London, United Kingdom",
            country: "united kingdom",
            city: "London",
            source: "location",
          },
        },
      ],
    });
    const failingManifest = {
      id: "hiringcafe",
      displayName: "Hiring Cafe",
      providesSources: ["hiringcafe"],
      run: vi
        .fn()
        .mockResolvedValue({ success: false, jobs: [], error: "boom" }),
    };
    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map([
        ["jobspy", jobspyManifest as any],
        ["hiringcafe", failingManifest as any],
      ]),
      manifestBySource: new Map([
        ["linkedin", jobspyManifest as any],
        ["hiringcafe", failingManifest as any],
      ]),
      availableSources: ["linkedin", "hiringcafe"],
    } as any);

    const result = await discoverJobsStep({
      mergedConfig: withFlag({ sources: ["linkedin", "hiringcafe"] }),
    });

    // No watermark is seeded here, so nothing narrows and the source ran with
    // the configured cap — which is the window the mark must be judged against.
    expect(result.scrapedSources).toEqual([
      { sourceKey: "jobspy", windowDays: 30, policyWindowDays: 30 },
    ]);
    expect(Date.parse(result.scrapeStartedAt)).not.toBeNaN();
  });

  it("narrows a provider instance against its own max-age override", async () => {
    const registryModule = await import("@server/extractors/registry");
    vi.mocked(registryModule.getExtractorRegistry).mockResolvedValue({
      manifests: new Map(),
      manifestBySource: new Map(),
      availableSources: [],
    } as any);

    const instancesModule = await import(
      "@server/repositories/provider-instances"
    );
    vi.mocked(instancesModule.getEnabledProviderInstances).mockResolvedValue([
      {
        id: "abc",
        providerId: "apify",
        actorRef: "acme/actor",
        label: "ACME",
        enabled: true,
        inputTemplateJson: "{}",
        outputMappingJson: "{}",
        mappings: {},
        maxAgeDays: 14,
        updatedAt: "",
      },
    ] as any);

    const providersModule = await import("@server/providers");
    const run = vi.fn().mockResolvedValue({ success: true, jobs: [] });
    vi.mocked(providersModule.getProvider).mockReturnValue({
      id: "apify",
      displayName: "Apify",
      templates: [],
      run,
    } as any);

    await setWatermarks([["apify:abc", daysAgo(2)]]);

    const result = await discoverJobsStep({
      mergedConfig: withFlag({ sources: [] }),
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: expect.objectContaining({ maxAgeDays: 2 }),
        runGlobals: expect.objectContaining({ maxAgeDays: "2" }),
      }),
    );
    expect(result.scrapedSources).toEqual([
      { sourceKey: "apify:abc", windowDays: 2, policyWindowDays: 14 },
    ]);
  });
});
