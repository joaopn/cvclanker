import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

describe.sequential("Pipeline API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  it("reports pipeline status", async () => {
    const res = await fetch(`${baseUrl}/api/pipeline/status`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.isRunning).toBe(false);
    expect(body.data.lastRun).toBeNull();
  });

  it("returns recent pipeline runs in the API envelope", async () => {
    const { db, schema } = await import("@server/db");

    await db.insert(schema.pipelineRuns).values({
      id: "run-history-1",
      startedAt: "2026-04-18T10:00:00.000Z",
      completedAt: "2026-04-18T10:05:00.000Z",
      status: "completed",
      jobsDiscovered: 12,
      jobsProcessed: 3,
      errorMessage: null,
    });

    const res = await fetch(`${baseUrl}/api/pipeline/runs`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.meta.requestId).toBeTruthy();
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "run-history-1",
        status: "completed",
        jobsDiscovered: 12,
        jobsProcessed: 3,
      }),
    ]);
  });

  it("returns pipeline run insights for a completed run", async () => {
    const { db, schema } = await import("@server/db");

    await db.insert(schema.pipelineRuns).values({
      id: "run-insight-1",
      startedAt: "2026-04-18T10:00:00.000Z",
      completedAt: "2026-04-18T10:10:00.000Z",
      status: "completed",
      jobsDiscovered: 8,
      jobsProcessed: 1,
      errorMessage: null,
      requestedConfig: {
        topN: 10,
        minSuitabilityCategory: "good_fit",
        sources: ["linkedin", "indeed"],
        enableCrawling: true,
        enableScoring: true,
        enableImporting: true,
        enableAutoTailoring: true,
      },
      effectiveConfig: {
        country: "united states",
        countryLabel: "United States",
        searchCities: ["London"],
        searchTermsCount: 2,
        workplaceTypes: ["remote"],
        locationSearchScope: "selected_only",
        locationMatchStrictness: "exact_only",
        compatibleSources: ["linkedin", "indeed"],
        skippedSources: [],
        blockedCompanyKeywordsCount: 1,
        sourceLimits: {
          maxJobsPerTerm: null,
        },
        autoSkipCategory: "bad_fit",
        pdfRenderer: "rxresume",
        models: {
          scorer: "model-scorer",
          tailoring: "model-tailoring",
          projectSelection: "model-project-selection",
        },
        resumeProjects: {
          maxProjects: 3,
          lockedProjectCount: 1,
          aiSelectableProjectCount: 2,
        },
      },
      resultSummary: {
        stage: "processing",
        jobsScored: 5,
        jobsSelected: 2,
        sourceErrors: ["indeed: upstream timeout"],
      },
    });

    await db.insert(schema.jobs).values([
      {
        id: "job-in-window-1",
        source: "manual",
        title: "Backend Engineer",
        employer: "Acme",
        jobUrl: "https://example.com/jobs/1",
        discoveredAt: "2026-04-18T10:01:00.000Z",
        createdAt: "2026-04-18T10:01:00.000Z",
        updatedAt: "2026-04-18T10:03:00.000Z",
        processedAt: "2026-04-18T10:06:00.000Z",
      },
      {
        id: "job-in-window-2",
        source: "manual",
        title: "Platform Engineer",
        employer: "Acme",
        jobUrl: "https://example.com/jobs/2",
        discoveredAt: "2026-04-18T10:02:00.000Z",
        createdAt: "2026-04-18T10:02:00.000Z",
        updatedAt: "2026-04-18T10:08:00.000Z",
      },
      {
        id: "job-outside-window",
        source: "manual",
        title: "Site Reliability Engineer",
        employer: "Acme",
        jobUrl: "https://example.com/jobs/3",
        discoveredAt: "2026-04-18T09:40:00.000Z",
        createdAt: "2026-04-18T09:40:00.000Z",
        updatedAt: "2026-04-18T09:50:00.000Z",
        processedAt: "2026-04-18T09:55:00.000Z",
      },
    ]);

    const res = await fetch(
      `${baseUrl}/api/pipeline/runs/run-insight-1/insights`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.meta.requestId).toBeTruthy();
    expect(body.data.run).toEqual(
      expect.objectContaining({
        id: "run-insight-1",
        status: "completed",
      }),
    );
    expect(body.data.exactMetrics.durationMs).toBe(600000);
    expect(body.data.savedDetails).toEqual(
      expect.objectContaining({
        requestedConfig: expect.objectContaining({
          topN: 10,
          sources: ["linkedin", "indeed"],
        }),
        resultSummary: expect.objectContaining({
          stage: "processing",
          sourceErrors: ["indeed: upstream timeout"],
        }),
      }),
    );
    expect(body.data.inferredMetrics.jobsCreated).toEqual({
      value: 2,
      quality: "inferred_from_timestamps",
    });
    expect(body.data.inferredMetrics.jobsUpdated).toEqual({
      value: 2,
      quality: "inferred_from_timestamps",
    });
    expect(body.data.inferredMetrics.jobsProcessed).toEqual({
      value: 1,
      quality: "inferred_from_timestamps",
    });
  });

  it("returns unavailable inferred metrics for incomplete runs", async () => {
    const { db, schema } = await import("@server/db");

    await db.insert(schema.pipelineRuns).values({
      id: "run-incomplete-1",
      startedAt: "2026-04-18T11:00:00.000Z",
      completedAt: null,
      status: "running",
      jobsDiscovered: 4,
      jobsProcessed: 0,
      errorMessage: null,
    });

    const res = await fetch(
      `${baseUrl}/api/pipeline/runs/run-incomplete-1/insights`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.savedDetails).toBeNull();
    expect(body.data.inferredMetrics.jobsCreated).toEqual({
      value: null,
      quality: "unavailable",
    });
    expect(body.data.inferredMetrics.jobsUpdated).toEqual({
      value: null,
      quality: "unavailable",
    });
    expect(body.data.inferredMetrics.jobsProcessed).toEqual({
      value: null,
      quality: "unavailable",
    });
  });

  it("returns not found for an unknown run insights request", async () => {
    const res = await fetch(
      `${baseUrl}/api/pipeline/runs/does-not-exist/insights`,
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.meta.requestId).toBeTruthy();
  });

  it("validates pipeline run payloads", async () => {
    const badRun = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minSuitabilityCategory: "not_a_category" }),
    });
    expect(badRun.status).toBe(400);

    const { runPipeline } = await import("@server/pipeline/index");
    const runRes = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topN: 5,
        minSuitabilityCategory: "good_fit",
        runBudget: 150,
        searchTerms: ["backend engineer"],
        country: "united kingdom",
        cityLocations: ["London"],
        workplaceTypes: ["remote", "hybrid"],
        searchScope: "selected_plus_remote_worldwide",
        matchStrictness: "flexible",
        sources: ["linkedin"],
      }),
    });
    const runBody = await runRes.json();
    expect(runBody.ok).toBe(true);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        topN: 5,
        minSuitabilityCategory: "good_fit",
        sources: ["linkedin"],
        locationIntent: expect.objectContaining({
          selectedCountry: "united kingdom",
          country: "united kingdom",
          cityLocations: ["London"],
          workplaceTypes: ["remote", "hybrid"],
          geoScope: "selected_plus_remote_worldwide",
          searchScope: "selected_plus_remote_worldwide",
          matchStrictness: "flexible",
        }),
      }),
      { trigger: "manual" },
    );

    const glassdoorRunRes = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: ["glassdoor"] }),
    });
    const glassdoorRunBody = await glassdoorRunRes.json();
    expect(glassdoorRunRes.status).toBe(400);
    expect(glassdoorRunBody.ok).toBe(false);
    expect(glassdoorRunBody.error.message).toContain("incompatible");

    const hiringcafeRunRes = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: ["hiringcafe"],
        country: "united kingdom",
      }),
    });
    const hiringcafeRunBody = await hiringcafeRunRes.json();
    expect(hiringcafeRunBody.ok).toBe(true);
    expect(runPipeline).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sources: ["hiringcafe"],
        locationIntent: expect.objectContaining({
          selectedCountry: "united kingdom",
          country: "united kingdom",
          cityLocations: [],
          // Unset in the body → filled from the resolved default Profile,
          // whose seed default is all three workplace types.
          workplaceTypes: ["remote", "hybrid", "onsite"],
          geoScope: "selected_only",
          searchScope: "selected_only",
          // The seed default: cities steer where the boards are searched, they
          // do not filter what comes back.
          matchStrictness: "flexible",
        }),
      }),
      { trigger: "manual" },
    );
  });

  async function createProfile(
    baseUrl: string,
    config: Record<string, unknown>,
    name = "Test profile",
  ): Promise<string> {
    const res = await fetch(`${baseUrl}/api/profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, config }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    return body.data.id as string;
  }

  describe("GET /run-options", () => {
    const optionsFor = async (profileId?: string) => {
      const res = await fetch(
        `${baseUrl}/api/pipeline/run-options${
          profileId ? `?profileId=${profileId}` : ""
        }`,
      );
      const body = await res.json();
      expect(body.ok).toBe(true);
      return body.data;
    };

    it("offers only sources the Profile pins", async () => {
      const profileId = await createProfile(baseUrl, {
        searchTerms: ["backend engineer"],
        searchCountry: "united kingdom",
        workplaceTypes: ["remote"],
        enabledSourceIds: ["test-linkedin"],
        scrapeMaxAgeDays: 14,
      });

      const data = await optionsFor(profileId);

      expect(data.profileIds).toEqual([profileId]);
      expect(data.capDays).toBe(14);
      expect(data.sources.map((source: { key: string }) => source.key)).toEqual(
        ["test-linkedin"],
      );
    });

    it("offers nothing for a Profile that pins nothing", async () => {
      // An empty pin set means NO extractors — there is no "empty = all"
      // fallback, so the menu must not invent one. Only reachable through an
      // EDIT: `createProfile` deliberately backfills an empty list with every
      // enabled source.
      const profileId = await createProfile(baseUrl, {
        searchTerms: ["x"],
        searchCountry: "united kingdom",
        enabledSourceIds: ["test-linkedin"],
      });
      const cleared = await fetch(`${baseUrl}/api/profiles/${profileId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { enabledSourceIds: [], providerInstanceIds: [] },
        }),
      });
      expect((await cleared.json()).ok).toBe(true);

      expect((await optionsFor(profileId)).sources).toEqual([]);
    });

    it("falls back to the default Profile, like a run with no profileId", async () => {
      const profileId = await createProfile(baseUrl, {
        searchTerms: ["x"],
        searchCountry: "united kingdom",
        enabledSourceIds: ["test-linkedin"],
        scrapeSinceLastRun: true,
      });
      // The default is a stored pointer, not "the newest profile" — the menu
      // has to resolve it exactly as `POST /run` does or it offers a set the
      // run would not use.
      await fetch(`${baseUrl}/api/profiles/${profileId}/set-default`, {
        method: "POST",
      });

      const data = await optionsFor();
      expect(data.profileIds).toEqual([profileId]);
      expect(data.defaultSinceLastRun).toBe(true);
    });

    it("merges several profiles into one offered set", async () => {
      const first = await createProfile(
        baseUrl,
        {
          searchTerms: ["x"],
          searchCountry: "united kingdom",
          enabledSourceIds: ["test-linkedin"],
          scrapeMaxAgeDays: 30,
          scrapeSinceLastRun: true,
        },
        "First",
      );
      const second = await createProfile(
        baseUrl,
        {
          searchTerms: ["y"],
          searchCountry: "united kingdom",
          enabledSourceIds: ["test-hiringcafe"],
          scrapeMaxAgeDays: 7,
          scrapeSinceLastRun: false,
        },
        "Second",
      );

      const res = await fetch(
        `${baseUrl}/api/pipeline/run-options?profileIds=${first},${second}`,
      );
      const { data } = await res.json();

      expect(data.profileIds).toEqual([first, second]);
      expect(
        data.sources.map((entry: { key: string }) => entry.key).sort(),
      ).toEqual(["test-hiringcafe", "test-linkedin"]);
      // The TIGHTEST ceiling governs: one window has to satisfy every leg.
      expect(data.capDays).toBe(7);
      // Only pre-press "since last run" when EVERY leg narrows, or the menu
      // claims a mode half the chain is not configured for.
      expect(data.defaultSinceLastRun).toBe(false);
    });

    /**
     * The merge only runs when a key appears for MORE than one profile, which
     * the disjoint-sources case above never exercises. Every rule that can be
     * wrong lives here.
     */
    it("merges a source two profiles share", async () => {
      const watermarks = await import(
        "@server/repositories/source-scrape-watermarks"
      );
      const shared = {
        searchTerms: ["x"],
        searchCountry: "united kingdom",
        enabledSourceIds: ["test-linkedin"],
      };
      const covered = await createProfile(
        baseUrl,
        { ...shared, scrapeMaxAgeDays: 30 },
        "Covered",
      );
      const uncovered = await createProfile(
        baseUrl,
        { ...shared, scrapeMaxAgeDays: 7 },
        "Uncovered",
      );
      await watermarks.recordScrapeWatermarks(
        covered,
        [
          {
            sourceKey: "test-linkedin",
            windowDays: 30,
            policyWindowDays: null,
          },
        ],
        "2026-08-20T00:00:00.000Z",
      );

      const res = await fetch(
        `${baseUrl}/api/pipeline/run-options?profileIds=${covered},${uncovered}`,
      );
      const { data } = await res.json();

      expect(data.sources).toHaveLength(1);
      // The tightest ceiling binds: one window must pass every leg's gate.
      expect(data.sources[0].capDays).toBe(7);
      // A leg that has never covered this source makes the chain reach back as
      // far as it ever would, so "never" wins over any date.
      expect(data.sources[0].lastScrapedAt).toBeNull();
    });

    it("keeps a ceiling that only one profile sets", async () => {
      const shared = {
        searchTerms: ["x"],
        searchCountry: "united kingdom",
        enabledSourceIds: ["test-linkedin"],
      };
      const uncapped = await createProfile(
        baseUrl,
        { ...shared, scrapeMaxAgeDays: null },
        "Uncapped",
      );
      const capped = await createProfile(
        baseUrl,
        { ...shared, scrapeMaxAgeDays: 7 },
        "Capped",
      );

      const res = await fetch(
        `${baseUrl}/api/pipeline/run-options?profileIds=${uncapped},${capped}`,
      );
      const { data } = await res.json();

      // An uncapped leg imposes nothing, so it must not null the answer: the
      // menu would say "no ceiling" while the capped leg's gate still refused.
      expect(data.capDays).toBe(7);
      expect(data.sources[0].capDays).toBe(7);
    });

    it("offers every enabled source when no Profile exists at all", async () => {
      // Cleared directly: the API refuses to delete the LAST profile, and a
      // fresh install genuinely has none.
      const { db, schema } = await import("@server/db");
      await db.delete(schema.profiles);

      const res = await fetch(`${baseUrl}/api/pipeline/run-options`);
      const { data } = await res.json();

      // A fresh install runs every enabled source, so the menu has to offer
      // them or its Run button is dead with nothing to tick.
      expect(data.profileIds).toEqual([]);
      expect(data.capDays).toBeNull();
      expect(data.sources.length).toBeGreaterThan(0);
    });

    it("404s for a profileId that does not exist", async () => {
      const res = await fetch(
        `${baseUrl}/api/pipeline/run-options?profileId=nope`,
      );
      expect(res.status).toBe(404);
    });

    it("answers with the standing live-status default and its cap", async () => {
      // App-level, not per-Profile: the rows a refresh covers are the whole
      // database's, so the menu gets the same numbers whichever Profile (or
      // none) it asks about.
      const data = await optionsFor();
      expect(data.defaultRefreshLiveStatus).toBe(false);
      expect(data.liveStatusRefreshLimit).toBe(100);
      expect(data.liveStatusRefreshMinAgeHours).toBe(24);

      await fetch(`${baseUrl}/api/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          liveStatusRefreshEnabled: true,
          liveStatusRefreshLimit: 40,
          liveStatusRefreshMinAgeHours: 6,
        }),
      });

      const updated = await optionsFor();
      expect(updated.defaultRefreshLiveStatus).toBe(true);
      expect(updated.liveStatusRefreshLimit).toBe(40);
      expect(updated.liveStatusRefreshMinAgeHours).toBe(6);
    });

    /**
     * An explicit `sources` list is gated on location compatibility, so a task
     * whose platforms include an incompatible one would 400 the run the moment
     * the user deselected anything else. The menu therefore only ever sends the
     * compatible subset — and shows the rest with a reason.
     */
    it("splits a task's platforms into compatible and incompatible", async () => {
      const profileId = await createProfile(baseUrl, {
        searchTerms: ["x"],
        // No cities, so Glassdoor (which requires them) cannot run.
        searchCountry: "united kingdom",
        searchCities: "",
        workplaceTypes: ["onsite"],
        locationSearchScope: "selected_only",
        enabledSourceIds: ["test-glassdoor", "test-linkedin"],
      });

      const data = await optionsFor(profileId);
      const glassdoor = data.sources.find(
        (source: { key: string }) => source.key === "test-glassdoor",
      );

      expect(glassdoor.platforms).toEqual([]);
      expect(glassdoor.incompatible).toEqual([
        expect.objectContaining({ platform: "glassdoor" }),
      ]);
      expect(glassdoor.incompatible[0].reasons.length).toBeGreaterThan(0);
    });

    it("reports the last successful scrape per source", async () => {
      const profileId = await createProfile(baseUrl, {
        searchTerms: ["x"],
        searchCountry: "united kingdom",
        enabledSourceIds: ["test-linkedin"],
      });
      const watermarks = await import(
        "@server/repositories/source-scrape-watermarks"
      );
      await watermarks.recordScrapeWatermarks(
        profileId,
        [
          {
            sourceKey: "test-linkedin",
            windowDays: 30,
            policyWindowDays: null,
          },
        ],
        "2026-08-20T00:00:00.000Z",
      );

      const data = await optionsFor(profileId);
      expect(data.sources[0].lastScrapedAt).toBe("2026-08-20T00:00:00.000Z");
    });
  });

  describe("run scrape window", () => {
    const windowProfile = (overrides: Record<string, unknown> = {}) => ({
      searchTerms: ["backend engineer"],
      searchCountry: "united kingdom",
      workplaceTypes: ["remote"],
      runBudget: 300,
      enabledSourceIds: ["test-linkedin"],
      ...overrides,
    });

    it("passes an explicit window through and forces the narrowing off", async () => {
      const { runPipeline } = await import("@server/pipeline/index");
      const profileId = await createProfile(
        baseUrl,
        windowProfile({ scrapeMaxAgeDays: 30, scrapeSinceLastRun: true }),
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, scrapeWindowDays: 1 }),
      });
      expect((await res.json()).ok).toBe(true);

      expect(runPipeline).toHaveBeenCalledWith(
        expect.objectContaining({
          scrapeWindowDays: 1,
          scrapeMaxAgeDays: 30,
          // An explicit window replaces the narrowing rather than stacking on
          // top of it, even though the Profile has the flag on.
          scrapeSinceLastRun: false,
        }),
        { trigger: "manual" },
      );
    });

    it("carries a live-status refresh request through to the run", async () => {
      const { runPipeline } = await import("@server/pipeline/index");
      const profileId = await createProfile(baseUrl, windowProfile());

      await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, refreshLiveStatus: true }),
      });

      expect(runPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ refreshLiveStatus: true }),
        { trigger: "manual" },
      );
    });

    it("leaves the live-status decision to the setting when the body is silent", async () => {
      const { runPipeline } = await import("@server/pipeline/index");
      const profileId = await createProfile(baseUrl, windowProfile());

      await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId }),
      });

      // Undefined, not false: `runPipeline` reads the standing setting when
      // the request expresses no opinion, and a hardcoded false here would
      // make the setting unreachable from every surface without the menu.
      const config = vi.mocked(runPipeline).mock.calls.at(-1)?.[0];
      expect(config).toBeDefined();
      expect(config?.refreshLiveStatus).toBeUndefined();
    });

    it("honours an explicit scrapeSinceLastRun:false over the Profile's flag", async () => {
      const { runPipeline } = await import("@server/pipeline/index");
      const profileId = await createProfile(
        baseUrl,
        windowProfile({ scrapeSinceLastRun: true }),
      );

      await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, scrapeSinceLastRun: false }),
      });

      expect(runPipeline).toHaveBeenCalledWith(
        expect.objectContaining({ scrapeSinceLastRun: false }),
        { trigger: "manual" },
      );
    });

    it("refuses a window wider than the Profile's max job age", async () => {
      const { runPipeline } = await import("@server/pipeline/index");
      const profileId = await createProfile(
        baseUrl,
        windowProfile({ scrapeMaxAgeDays: 7 }),
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, scrapeWindowDays: 30 }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.details.violations).toEqual([
        expect.objectContaining({ kind: "over_cap", limitDays: 7 }),
      ]);
      // Refused before anything starts — the whole run, not just the source.
      expect(runPipeline).not.toHaveBeenCalled();
    });

    it("refuses the chain if ANY profile's cap is exceeded", async () => {
      const { runProfileSequence } = await import("@server/pipeline/index");
      const ok = await createProfile(
        baseUrl,
        windowProfile({ scrapeMaxAgeDays: 30 }),
        "Roomy",
      );
      const tight = await createProfile(
        baseUrl,
        windowProfile({ scrapeMaxAgeDays: 2 }),
        "Tight",
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: [ok, tight], scrapeWindowDays: 7 }),
      });

      expect(res.status).toBe(400);
      expect(runProfileSequence).not.toHaveBeenCalled();
    });

    it("rejects an explicit window combined with since-last-run", async () => {
      const profileId = await createProfile(baseUrl, windowProfile());

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileId,
          scrapeWindowDays: 1,
          scrapeSinceLastRun: true,
        }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(
        /cannot be combined with scrapeSinceLastRun/,
      );
    });

    const seedInstance = async (
      overrides: Record<string, unknown> = {},
    ): Promise<string> => {
      const { db, schema } = await import("@server/db");
      await db.insert(schema.providerInstances).values({
        id: "inst-window",
        providerId: "apify",
        actorRef: "cheap_scraper/linkedin-job-scraper",
        label: "Cheap scraper",
        templateId: "cheap-scraper-linkedin",
        enabled: true,
        inputTemplateJson: "{}",
        outputMappingJson: "{}",
        mappingsJson: {},
        ...overrides,
      });
      return "inst-window";
    };

    it("refuses a window over a provider instance's own max age", async () => {
      const { runPipeline } = await import("@server/pipeline/index");
      const instanceId = await seedInstance({ maxAgeDays: 3 });
      const profileId = await createProfile(
        baseUrl,
        windowProfile({
          scrapeMaxAgeDays: 30,
          providerInstanceIds: [instanceId],
        }),
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, scrapeWindowDays: 10 }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      // The instance's own max age wins over the Profile's 30, so it is the
      // ceiling — this is the half of the gate no route test covered.
      expect(body.error.details.violations).toEqual([
        expect.objectContaining({
          sourceKey: `apify:${instanceId}`,
          kind: "over_cap",
          limitDays: 3,
        }),
      ]);
      expect(runPipeline).not.toHaveBeenCalled();
    });

    /**
     * The window is under every configured ceiling, so the cap check is silent
     * — but cheap_scraper cannot look back past 30 days and would scrape half
     * of what was asked.
     */
    it("refuses a window a bucketing actor would clamp down", async () => {
      const instanceId = await seedInstance();
      const profileId = await createProfile(
        baseUrl,
        windowProfile({
          scrapeMaxAgeDays: null,
          providerInstanceIds: [instanceId],
        }),
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, scrapeWindowDays: 60 }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.details.violations).toEqual([
        expect.objectContaining({ kind: "over_bucket", limitDays: 30 }),
      ]);
      expect(body.error.message).toMatch(/Lower the window or deselect them/);
    });

    it("allows a window a bucketing actor merely rounds up", async () => {
      const { runPipeline } = await import("@server/pipeline/index");
      const instanceId = await seedInstance();
      const profileId = await createProfile(
        baseUrl,
        windowProfile({
          scrapeMaxAgeDays: null,
          providerInstanceIds: [instanceId],
        }),
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, scrapeWindowDays: 2 }),
      });

      expect((await res.json()).ok).toBe(true);
      expect(runPipeline).toHaveBeenCalled();
    });

    /**
     * A source the run would never touch must not be able to refuse it: the
     * menu greys such a source out, so there is no tick to clear.
     */
    it("ignores a pinned source the Sources page has disabled", async () => {
      const { runPipeline } = await import("@server/pipeline/index");
      const configs = await import("@server/repositories/source-configs");
      await configs.upsertSourceConfig("test-linkedin", { enabled: true });
      await configs.upsertSourceConfig("test-indeed", { enabled: false });

      const profileId = await createProfile(
        baseUrl,
        windowProfile({
          scrapeMaxAgeDays: 30,
          enabledSourceIds: ["test-linkedin", "test-indeed"],
        }),
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, scrapeWindowDays: 30 }),
      });

      expect((await res.json()).ok).toBe(true);
      expect(runPipeline).toHaveBeenCalled();
    });

    it("allows a window up to the cap", async () => {
      const { runPipeline } = await import("@server/pipeline/index");
      const profileId = await createProfile(
        baseUrl,
        windowProfile({ scrapeMaxAgeDays: 7 }),
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, scrapeWindowDays: 7 }),
      });

      expect((await res.json()).ok).toBe(true);
      expect(runPipeline).toHaveBeenCalled();
    });
  });

  it("resolves scrape config from an explicit profileId", async () => {
    const { runPipeline } = await import("@server/pipeline/index");
    const profileId = await createProfile(baseUrl, {
      searchTerms: ["backend engineer"],
      searchCountry: "united kingdom",
      searchCities: "",
      workplaceTypes: ["remote"],
      locationSearchScope: "selected_plus_remote_worldwide",
      locationMatchStrictness: "flexible",
      scrapeMaxAgeDays: 14,
      blockedCompanyKeywords: ["scam corp"],
      runBudget: 300,
      topN: 7,
      minSuitabilityCategory: "very_good_fit",
      enabledSourceIds: ["test-linkedin"],
    });

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        topN: 7,
        minSuitabilityCategory: "very_good_fit",
        // enabledSourceIds (extractor ids) expand to their platform ids.
        sources: ["linkedin"],
        searchTerms: ["backend engineer"],
        scrapeMaxAgeDays: 14,
        blockedCompanyKeywords: ["scam corp"],
        // 300 budget / (1 term × 1 source).
        maxJobsPerTerm: 300,
        locationIntent: expect.objectContaining({
          selectedCountry: "united kingdom",
          cityLocations: [],
          workplaceTypes: ["remote"],
          geoScope: "selected_plus_remote_worldwide",
          matchStrictness: "flexible",
        }),
      }),
      { trigger: "manual" },
    );
  });

  it("lets body fields override the profile per-field", async () => {
    const { runPipeline } = await import("@server/pipeline/index");
    const profileId = await createProfile(baseUrl, {
      searchTerms: ["backend engineer"],
      searchCountry: "united kingdom",
      workplaceTypes: ["remote"],
      scrapeMaxAgeDays: 14,
      blockedCompanyKeywords: ["scam corp"],
      runBudget: 300,
      topN: 7,
      minSuitabilityCategory: "very_good_fit",
      enabledSourceIds: ["test-linkedin"],
    });

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId,
        searchTerms: ["override term"],
        topN: 3,
        maxJobsPerTerm: 55,
        country: "united kingdom",
        cityLocations: ["London"],
        workplaceTypes: ["remote", "hybrid"],
        searchScope: "selected_plus_remote_worldwide",
        matchStrictness: "flexible",
        sources: ["linkedin"],
      }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        topN: 3,
        sources: ["linkedin"],
        searchTerms: ["override term"],
        maxJobsPerTerm: 55,
        // Profile-only fields still flow through the override.
        scrapeMaxAgeDays: 14,
        blockedCompanyKeywords: ["scam corp"],
        locationIntent: expect.objectContaining({
          selectedCountry: "united kingdom",
          cityLocations: ["London"],
          workplaceTypes: ["remote", "hybrid"],
        }),
      }),
      { trigger: "manual" },
    );
  });

  it("returns not found for an unknown explicit profileId", async () => {
    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId: "does-not-exist" }),
    });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("falls back to the default profile when no profileId is given", async () => {
    const { runPipeline } = await import("@server/pipeline/index");
    const profileId = await createProfile(baseUrl, {
      searchTerms: ["ml engineer"],
      searchCountry: "germany",
      searchCities: "Berlin",
      workplaceTypes: ["onsite"],
      locationSearchScope: "selected_only",
      locationMatchStrictness: "exact_only",
      scrapeMaxAgeDays: 30,
      blockedCompanyKeywords: ["blockedco"],
      runBudget: 200,
      topN: 4,
      minSuitabilityCategory: "good_fit",
      enabledSourceIds: ["test-linkedin"],
    });

    const setDefaultRes = await fetch(
      `${baseUrl}/api/profiles/${profileId}/set-default`,
      { method: "POST" },
    );
    expect((await setDefaultRes.json()).ok).toBe(true);

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        topN: 4,
        sources: ["linkedin"],
        searchTerms: ["ml engineer"],
        scrapeMaxAgeDays: 30,
        blockedCompanyKeywords: ["blockedco"],
        maxJobsPerTerm: 200,
        locationIntent: expect.objectContaining({
          selectedCountry: "germany",
          cityLocations: ["Berlin"],
          workplaceTypes: ["onsite"],
        }),
      }),
      { trigger: "manual" },
    );
  });

  it("rejects a run whose only pinned source is disabled on the Sources page", async () => {
    // The silent-zero regression. The pin list is NON-empty, so a guard that
    // only asked "did you select something?" would let this run start — and
    // discovery would then drop the disabled extractor with a bare `continue`,
    // finishing successfully having scraped nothing.
    const { runPipeline } = await import("@server/pipeline/index");
    const { db, schema } = await import("@server/db");
    const { eq } = await import("drizzle-orm");

    const profileId = await createProfile(baseUrl, {
      searchTerms: ["ml engineer"],
      searchCountry: "germany",
      enabledSourceIds: ["test-linkedin"],
      providerInstanceIds: [],
    });

    await db
      .update(schema.sourceConfigs)
      .set({ enabled: false })
      .where(eq(schema.sourceConfigs.extractorId, "test-linkedin"));

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("rejects a run when the profile selects no sources at all", async () => {
    const { runPipeline } = await import("@server/pipeline/index");

    // A source-less profile can no longer be CREATED — createProfile fills an
    // absent-or-empty selection with every enabled source. It is still
    // reachable by clearing the selection on an update (which must stay able
    // to narrow one), so that is the path this 400 backstops.
    const profileId = await createProfile(baseUrl, {
      searchTerms: ["ml engineer"],
      searchCountry: "germany",
    });

    const clearRes = await fetch(`${baseUrl}/api/profiles/${profileId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: { enabledSourceIds: [], providerInstanceIds: [] },
      }),
    });
    expect((await clearRes.json()).ok).toBe(true);

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("still runs a per-source re-run scoped to one extractor", async () => {
    // The re-run button empties the OTHER side deliberately: an extractor
    // re-run posts `providerInstanceIds: []`. That must not trip the guard.
    const { runPipeline } = await import("@server/pipeline/index");
    await createProfile(baseUrl, {
      searchTerms: ["ml engineer"],
      searchCountry: "germany",
      enabledSourceIds: ["test-linkedin"],
    });

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: ["linkedin"],
        providerInstanceIds: [],
        partial: true,
      }),
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: ["linkedin"],
        providerInstanceIds: [],
        partial: true,
      }),
      { trigger: "manual" },
    );
  });

  it("passes a per-run discoveryConcurrency override through to the pipeline", async () => {
    // "Retry all failed" re-runs several sources one at a time.
    const { runPipeline } = await import("@server/pipeline/index");
    await createProfile(baseUrl, {
      searchTerms: ["ml engineer"],
      searchCountry: "germany",
      enabledSourceIds: ["test-linkedin", "test-indeed"],
    });

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: ["linkedin", "indeed"],
        providerInstanceIds: [],
        partial: true,
        discoveryConcurrency: 1,
      }),
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: ["linkedin", "indeed"],
        partial: true,
        discoveryConcurrency: 1,
      }),
      { trigger: "manual" },
    );
  });

  it("skips a source disabled since the run a partial re-run retries, and names it", async () => {
    // A banner page keeps a failed row after its source is disabled on the
    // Sources page; "Retry all" must still retry the others.
    const { runPipeline } = await import("@server/pipeline/index");
    const { db, schema } = await import("@server/db");
    const { eq } = await import("drizzle-orm");
    await createProfile(baseUrl, {
      searchTerms: ["ml engineer"],
      searchCountry: "germany",
      enabledSourceIds: ["test-linkedin", "test-indeed"],
    });
    await db
      .update(schema.sourceConfigs)
      .set({ enabled: false })
      .where(eq(schema.sourceConfigs.extractorId, "test-indeed"));

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: ["linkedin", "indeed"],
        providerInstanceIds: ["inst-gone"],
        partial: true,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.skippedDisabledSources).toEqual(["indeed", "inst-gone"]);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: ["linkedin"],
        providerInstanceIds: [],
        partial: true,
      }),
      { trigger: "manual" },
    );
  });

  it("keeps an omitted list meaning every enabled source when a partial re-run skips", async () => {
    // `sources` omitted = all enabled extractors, so skipping the one named
    // instance must not read as "nothing left".
    const { runPipeline } = await import("@server/pipeline/index");
    const profileId = await createProfile(baseUrl, {
      searchTerms: ["ml engineer"],
      searchCountry: "germany",
      enabledSourceIds: ["test-linkedin"],
    });

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId,
        providerInstanceIds: ["inst-gone"],
        partial: true,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.skippedDisabledSources).toEqual(["inst-gone"]);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: ["linkedin"],
        providerInstanceIds: [],
      }),
      { trigger: "manual" },
    );
  });

  it("still rejects a partial re-run whose every source is disabled", async () => {
    const { runPipeline } = await import("@server/pipeline/index");
    const { db, schema } = await import("@server/db");
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.sourceConfigs)
      .set({ enabled: false })
      .where(eq(schema.sourceConfigs.extractorId, "test-linkedin"));

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: ["linkedin"],
        providerInstanceIds: [],
        partial: true,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.message).toMatch(/not enabled/i);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("rejects a discoveryConcurrency outside the pool bounds", async () => {
    const { runPipeline } = await import("@server/pipeline/index");

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discoveryConcurrency: 0 }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("still runs a per-source re-run scoped to one Apify instance", async () => {
    // The mirror shape: an Apify re-run posts `sources: []`. A naive
    // "resolved sources empty → reject" would 400 every one of these.
    const { runPipeline } = await import("@server/pipeline/index");
    const { db, schema } = await import("@server/db");

    await db.insert(schema.providerInstances).values({
      id: "inst-1",
      providerId: "apify",
      actorRef: "acme/actor",
      label: "Acme actor",
      templateId: null,
      enabled: true,
      inputTemplateJson: "{}",
      outputMappingJson: "{}",
      mappingsJson: {},
    });

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: [],
        providerInstanceIds: ["inst-1"],
        partial: true,
      }),
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [],
        providerInstanceIds: ["inst-1"],
      }),
      { trigger: "manual" },
    );
  });

  it("excludes Apify instances from a remote-type profile's run", async () => {
    const { runPipeline } = await import("@server/pipeline/index");
    const { db, schema } = await import("@server/db");
    await db.insert(schema.providerInstances).values({
      id: "inst-remote",
      providerId: "apify",
      actorRef: "acme/actor",
      label: "Acme actor",
      templateId: null,
      enabled: true,
      inputTemplateJson: "{}",
      outputMappingJson: "{}",
      mappingsJson: {},
    });
    const profileId = await createProfile(baseUrl, {
      searchTerms: ["backend engineer"],
      searchCountry: "portugal",
      searchCities: "Lisbon|Porto",
      workplaceTypes: ["hybrid", "onsite"],
      remoteProfile: true,
      remoteLocationBlocklist: ["US only"],
      enabledSourceIds: ["test-linkedin"],
      providerInstanceIds: ["inst-remote"],
    });

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    // The stored country/cities are kept for when the flag is unticked but
    // must not seed a remote run; the blocklist rides through.
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        providerInstanceIds: [],
        locationIntent: expect.objectContaining({
          remoteProfile: true,
          selectedCountry: null,
          cityLocations: [],
          // The remote profile IS the remote arrangement, whatever is stored.
          workplaceTypes: ["remote"],
          remoteLocationBlocklist: ["US only"],
        }),
      }),
      { trigger: "manual" },
    );
  });

  it("names the remote exclusion when it emptied the run's sources", async () => {
    const { db, schema } = await import("@server/db");
    await db.insert(schema.providerInstances).values({
      id: "inst-remote-only",
      providerId: "apify",
      actorRef: "acme/actor",
      label: "Acme actor",
      templateId: null,
      enabled: true,
      inputTemplateJson: "{}",
      outputMappingJson: "{}",
      mappingsJson: {},
    });
    // Creation auto-fills an empty source selection, so narrow via update —
    // same path as the source-less 400 backstop above.
    const profileId = await createProfile(baseUrl, {
      searchTerms: ["backend engineer"],
      searchCountry: "portugal",
      remoteProfile: true,
      providerInstanceIds: ["inst-remote-only"],
    });
    const clearRes = await fetch(`${baseUrl}/api/profiles/${profileId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { enabledSourceIds: [] } }),
    });
    expect((await clearRes.json()).ok).toBe(true);

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.message).toContain("remote-type");
    expect(body.error.message).not.toContain("Enable a source on the Sources");
  });

  it("aims a per-source re-run at the page of the profile it names", async () => {
    const { runPipeline, targetProfileRunPage } = await import(
      "@server/pipeline/index"
    );
    const profileId = await createProfile(baseUrl, {
      searchTerms: ["ml engineer"],
      searchCountry: "germany",
      enabledSourceIds: ["test-linkedin"],
    });

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId,
        sources: ["linkedin"],
        providerInstanceIds: [],
        partial: true,
      }),
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    // The page the row was clicked on owns both the funnel it reconciles into
    // and the Search Profile the run config is resolved from.
    // The trigger is explicit: this route fires while NO run is in flight, so
    // an inherited "whichever ran last" would search the wrong partition's pages.
    expect(targetProfileRunPage).toHaveBeenCalledWith(profileId, "manual");
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ profileId, partial: true }),
      { trigger: "manual" },
    );
  });

  it("does not aim a full run at a page", async () => {
    const { targetProfileRunPage } = await import("@server/pipeline/index");
    const profileId = await createProfile(baseUrl, {
      searchTerms: ["ml engineer"],
      searchCountry: "germany",
      enabledSourceIds: ["test-linkedin"],
    });

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileId }),
    });

    expect((await res.json()).ok).toBe(true);
    // A full run owns the whole banner and drops the pages, as it always has.
    expect(targetProfileRunPage).not.toHaveBeenCalled();
  });

  it("rejects a body-provided source whose extractor is disabled", async () => {
    // Symmetric with provider instances, which already 400 on a disabled id.
    const { runPipeline } = await import("@server/pipeline/index");
    const { db, schema } = await import("@server/db");
    const { eq } = await import("drizzle-orm");

    await db
      .update(schema.sourceConfigs)
      .set({ enabled: false })
      .where(eq(schema.sourceConfigs.extractorId, "test-linkedin"));

    const res = await fetch(`${baseUrl}/api/pipeline/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: ["linkedin"] }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/not enabled/i);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  describe("multi-profile runs", () => {
    const runnableConfig = (term: string) => ({
      searchTerms: [term],
      searchCountry: "united kingdom",
      workplaceTypes: ["remote"],
      runBudget: 300,
      enabledSourceIds: ["test-linkedin"],
    });

    it("hands every profile's resolved config to the sequence, in order", async () => {
      const { runProfileSequence, runPipeline } = await import(
        "@server/pipeline/index"
      );
      const first = await createProfile(
        baseUrl,
        runnableConfig("backend engineer"),
        "First",
      );
      const second = await createProfile(
        baseUrl,
        { ...runnableConfig("data engineer"), topN: 9 },
        "Second",
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: [first, second] }),
      });
      const body = await res.json();

      expect(body.ok).toBe(true);
      expect(body.data.profileCount).toBe(2);
      // The chain owns the runs; the route never calls runPipeline itself.
      expect(runPipeline).not.toHaveBeenCalled();
      expect(runProfileSequence).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            profile: { id: first, name: "First" },
            config: expect.objectContaining({
              searchTerms: ["backend engineer"],
              sources: ["linkedin"],
            }),
          }),
          expect.objectContaining({
            profile: { id: second, name: "Second" },
            config: expect.objectContaining({
              searchTerms: ["data engineer"],
              topN: 9,
            }),
          }),
        ],
        { trigger: "manual" },
      );
    });

    it("starts nothing when a later profile in the list is unknown", async () => {
      const { runProfileSequence, endProfileSequence } = await import(
        "@server/pipeline/index"
      );
      const first = await createProfile(baseUrl, runnableConfig("backend"));

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: [first, "missing-profile"] }),
      });
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error.message).toMatch(/missing-profile/);
      expect(runProfileSequence).not.toHaveBeenCalled();
      // The claim must go back, or every later multi-run 409s forever.
      expect(endProfileSequence).toHaveBeenCalled();
    });

    it("names the offending profile when one selects no sources", async () => {
      const { runProfileSequence } = await import("@server/pipeline/index");
      const good = await createProfile(
        baseUrl,
        runnableConfig("backend"),
        "Good one",
      );
      // createProfile backfills an empty selection with every enabled source,
      // so the source-less state is only reachable by clearing on update.
      const empty = await createProfile(
        baseUrl,
        runnableConfig("backend"),
        "Empty one",
      );
      const clearRes = await fetch(`${baseUrl}/api/profiles/${empty}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { enabledSourceIds: [], providerInstanceIds: [] },
        }),
      });
      expect((await clearRes.json()).ok).toBe(true);

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: [good, empty] }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.message).toMatch(/Empty one/);
      expect(runProfileSequence).not.toHaveBeenCalled();
    });

    it.each([
      ["profileId", { profileId: "p1" }],
      ["partial", { partial: true }],
    ])("rejects profileIds combined with %s", async (key, extra) => {
      const { runProfileSequence } = await import("@server/pipeline/index");
      const profileId = await createProfile(baseUrl, runnableConfig("backend"));

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: [profileId], ...extra }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.message).toMatch(new RegExp(key));
      expect(runProfileSequence).not.toHaveBeenCalled();
    });

    /**
     * A chain's list NARROWS each leg rather than replacing it. Overriding
     * would hand a profile sources it never pinned — which is why this
     * combination used to be refused outright.
     */
    it("narrows each profile's own sources rather than replacing them", async () => {
      const { runProfileSequence } = await import("@server/pipeline/index");
      const first = await createProfile(
        baseUrl,
        { ...runnableConfig("backend"), enabledSourceIds: ["test-linkedin"] },
        "First",
      );
      const second = await createProfile(
        baseUrl,
        {
          ...runnableConfig("data"),
          enabledSourceIds: ["test-linkedin", "test-hiringcafe"],
        },
        "Second",
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileIds: [first, second],
          sources: ["hiringcafe"],
        }),
      });

      expect((await res.json()).ok).toBe(true);
      // The first profile never pinned Hiring Cafe, so the list leaves it
      // nothing — and it is DROPPED from the chain rather than handed a source
      // it did not select or run as an empty leg.
      expect(runProfileSequence).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            profile: expect.objectContaining({ name: "Second" }),
            config: expect.objectContaining({ sources: ["hiringcafe"] }),
          }),
        ],
        { trigger: "manual" },
      );
    });

    it("refuses only when the filter leaves EVERY profile empty", async () => {
      const { runProfileSequence } = await import("@server/pipeline/index");
      const first = await createProfile(
        baseUrl,
        { ...runnableConfig("backend"), enabledSourceIds: ["test-linkedin"] },
        "First",
      );
      const second = await createProfile(
        baseUrl,
        { ...runnableConfig("data"), enabledSourceIds: ["test-linkedin"] },
        "Second",
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileIds: [first, second],
          sources: ["hiringcafe"],
          providerInstanceIds: [],
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.message).toMatch(/leave nothing to run/);
      expect(runProfileSequence).not.toHaveBeenCalled();
    });

    it("narrows a chain's provider instances the same way", async () => {
      const { runProfileSequence } = await import("@server/pipeline/index");
      const { db, schema } = await import("@server/db");
      await db.insert(schema.providerInstances).values([
        {
          id: "inst-a",
          providerId: "apify",
          actorRef: "acme/a",
          label: "A",
          templateId: null,
          enabled: true,
          inputTemplateJson: "{}",
          outputMappingJson: "{}",
          mappingsJson: {},
        },
        {
          id: "inst-b",
          providerId: "apify",
          actorRef: "acme/b",
          label: "B",
          templateId: null,
          enabled: true,
          inputTemplateJson: "{}",
          outputMappingJson: "{}",
          mappingsJson: {},
        },
      ]);
      const first = await createProfile(
        baseUrl,
        { ...runnableConfig("backend"), providerInstanceIds: ["inst-a"] },
        "First",
      );
      const second = await createProfile(
        baseUrl,
        {
          ...runnableConfig("data"),
          providerInstanceIds: ["inst-a", "inst-b"],
        },
        "Second",
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileIds: [first, second],
          providerInstanceIds: ["inst-b"],
        }),
      });

      expect((await res.json()).ok).toBe(true);
      expect(runProfileSequence).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            config: expect.objectContaining({ providerInstanceIds: [] }),
          }),
          expect.objectContaining({
            config: expect.objectContaining({
              providerInstanceIds: ["inst-b"],
            }),
          }),
        ],
        { trigger: "manual" },
      );
    });

    /**
     * A filter says "nothing outside this list", so an entry a given leg cannot
     * run drops out for that leg. Gating it would let one profile's geography
     * refuse the whole chain.
     */
    it("does not refuse a chain over a source one leg cannot run", async () => {
      const { runProfileSequence } = await import("@server/pipeline/index");
      const first = await createProfile(
        baseUrl,
        {
          ...runnableConfig("backend"),
          searchCities: "",
          workplaceTypes: ["onsite"],
          locationSearchScope: "selected_only",
          enabledSourceIds: ["test-glassdoor", "test-linkedin"],
        },
        "No cities",
      );
      const second = await createProfile(
        baseUrl,
        { ...runnableConfig("data"), enabledSourceIds: ["test-linkedin"] },
        "Second",
      );

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileIds: [first, second],
          sources: ["glassdoor", "linkedin"],
        }),
      });

      expect((await res.json()).ok).toBe(true);
      expect(runProfileSequence).toHaveBeenCalled();
    });

    it("rejects duplicate profileIds", async () => {
      const { runProfileSequence } = await import("@server/pipeline/index");
      const profileId = await createProfile(baseUrl, runnableConfig("backend"));

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: [profileId, profileId] }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.message).toMatch(/duplicate/i);
      expect(runProfileSequence).not.toHaveBeenCalled();
    });

    it("returns conflict when a sequence is already claimed", async () => {
      const { runProfileSequence, tryBeginProfileSequence } = await import(
        "@server/pipeline/index"
      );
      vi.mocked(tryBeginProfileSequence).mockReturnValueOnce(false);
      const profileId = await createProfile(baseUrl, runnableConfig("backend"));

      const res = await fetch(`${baseUrl}/api/pipeline/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: [profileId] }),
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.error.code).toBe("CONFLICT");
      expect(runProfileSequence).not.toHaveBeenCalled();
    });

    it("accepts a cancel in the gap between profiles", async () => {
      const { isProfileSequenceActive, requestProfileSequenceCancel } =
        await import("@server/pipeline/index");
      // The gap: no run is in flight (requestPipelineCancel declines) but the
      // chain is live.
      vi.mocked(isProfileSequenceActive).mockReturnValueOnce(true);

      const res = await fetch(`${baseUrl}/api/pipeline/cancel`, {
        method: "POST",
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(requestProfileSequenceCancel).toHaveBeenCalled();
    });
  });

  it("returns conflict when cancelling with no active pipeline", async () => {
    const res = await fetch(`${baseUrl}/api/pipeline/cancel`, {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
    expect(typeof body.meta.requestId).toBe("string");
  });

  it("accepts cancellation when pipeline is running", async () => {
    const { requestPipelineCancel } = await import("@server/pipeline/index");
    vi.mocked(requestPipelineCancel).mockReturnValue({
      accepted: true,
      pipelineRunId: "run-1",
      alreadyRequested: false,
    });

    const res = await fetch(`${baseUrl}/api/pipeline/cancel`, {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.pipelineRunId).toBe("run-1");
    expect(body.data.alreadyRequested).toBe(false);
    expect(typeof body.meta.requestId).toBe("string");
  });

  it("streams pipeline progress over SSE", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/pipeline/progress`, {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    if (reader) {
      try {
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        expect(text).toContain("data:");
        expect(text).toContain('"crawlingSource"');
        expect(text).toContain('"crawlingSourcesTotal"');
      } finally {
        await reader.cancel();
        controller.abort();
      }
    } else {
      controller.abort();
    }
  });

  describe("run partitions on the wire", () => {
    // `run-job-capture` is NOT part of the mocked pipeline barrel, so these
    // drive the real store. It is a module singleton whose reset only sweeps
    // the ACTIVE trigger's scopes, so both partitions are cleared by hand.
    async function captureModule() {
      return await import("@server/pipeline/run-job-capture");
    }

    async function clearCaptures() {
      const capture = await captureModule();
      for (const trigger of ["manual", "schedule"] as const) {
        capture.setRunCaptureTrigger(trigger);
        capture.resetAllRunJobCaptures();
      }
      capture.setRunCaptureTrigger("manual");
    }

    beforeEach(clearCaptures);
    afterEach(clearCaptures);

    it("dismisses the partition the request names", async () => {
      const { dismissRunBanner } = await import("@server/pipeline/index");

      const res = await fetch(`${baseUrl}/api/pipeline/progress/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startedAt: "2026-08-29T10:00:00.000Z",
          trigger: "schedule",
        }),
      });

      expect(res.status).toBe(200);
      expect(dismissRunBanner).toHaveBeenCalledWith(
        "2026-08-29T10:00:00.000Z",
        "schedule",
      );
    });

    it("dismisses the manual table when the request names no partition", async () => {
      const { dismissRunBanner } = await import("@server/pipeline/index");

      const res = await fetch(`${baseUrl}/api/pipeline/progress/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      // The table every client had before scheduled runs existed.
      expect(dismissRunBanner).toHaveBeenCalledWith(undefined, "manual");
    });

    it("rejects a dismissal for a partition that does not exist", async () => {
      const res = await fetch(`${baseUrl}/api/pipeline/progress/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "nonsense" }),
      });

      expect(res.status).toBe(400);
    });

    it("reads run jobs from the partition the query names", async () => {
      const capture = await captureModule();
      capture.setRunCaptureTrigger("schedule");
      capture.captureRunJobs("workingnomads", "scraped", [
        { title: "Scheduled find", employer: "Acme", jobUrl: "https://a/1" },
      ]);
      capture.setRunCaptureTrigger("manual");
      capture.captureRunJobs("workingnomads", "scraped", [
        { title: "Manual find", employer: "Acme", jobUrl: "https://a/2" },
      ]);

      const scheduled = await fetch(
        `${baseUrl}/api/pipeline/run-jobs?source=workingnomads&bucket=scraped&trigger=schedule`,
      ).then((res) => res.json());

      expect(
        scheduled.data.jobs.map((job: { title: string }) => job.title),
      ).toEqual(["Scheduled find"]);
    });

    it("reads the manual store when the query names no partition", async () => {
      const capture = await captureModule();
      capture.setRunCaptureTrigger("schedule");
      capture.captureRunJobs("workingnomads", "scraped", [
        { title: "Scheduled find", employer: "Acme", jobUrl: "https://a/1" },
      ]);
      capture.setRunCaptureTrigger("manual");

      // A read arrives long after the capture, so an absent partition resolves
      // to the manual store rather than to whatever ran last.
      const body = await fetch(
        `${baseUrl}/api/pipeline/run-jobs?source=workingnomads&bucket=scraped`,
      ).then((res) => res.json());

      expect(body.data.jobs).toEqual([]);
    });

    it("rejects a run-jobs read for a partition that does not exist", async () => {
      const res = await fetch(
        `${baseUrl}/api/pipeline/run-jobs?source=workingnomads&bucket=scraped&trigger=nonsense`,
      );

      expect(res.status).toBe(400);
    });
  });
});
