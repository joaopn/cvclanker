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
          matchStrictness: "exact_only",
        }),
      }),
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
    expect(targetProfileRunPage).toHaveBeenCalledWith(profileId);
    expect(runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ profileId, partial: true }),
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
      expect(runProfileSequence).toHaveBeenCalledWith([
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
      ]);
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
      ["sources", { sources: ["linkedin"] }],
      ["providerInstanceIds", { providerInstanceIds: ["x"] }],
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
});
