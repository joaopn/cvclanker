// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearProfileRunPageTarget,
  getProgress,
  progressHelpers,
  resetProfileRunStats,
  resetProgress,
  setActiveProfileRun,
  subscribeToProgress,
  targetProfileRunPage,
} from "./progress";

describe("pipeline progress source-stats tracking", () => {
  beforeEach(() => {
    resetProgress();
  });

  it("creates rows when a source starts with explicit platforms (jobspy split)", () => {
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("jobspy", 0, 1, {
      platforms: ["linkedin", "indeed", "glassdoor"],
    });

    const stats = getProgress().sourceStats;
    expect(stats.map((row) => row.id)).toEqual([
      "indeed",
      "linkedin",
      "glassdoor",
    ]);
    // Multi-platform extractor: each row's label gets a `[<extractorId>]`
    // suffix so the banner shows the underlying extractor alongside the
    // platform.
    expect(stats.map((row) => row.label)).toEqual([
      "Indeed [jobspy]",
      "LinkedIn [jobspy]",
      "Glassdoor [jobspy]",
    ]);
    expect(stats.every((row) => row.status === "running")).toBe(true);
    expect(stats.every((row) => row.jobsScraped === 0)).toBe(true);
  });

  it("does not suffix the label for 1:1 extractors", () => {
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("hiringcafe", 0, 1, {
      platforms: ["hiringcafe"],
    });

    const row = getProgress().sourceStats.find((r) => r.id === "hiringcafe");
    expect(row?.label).toBe("Hiring Cafe");
  });

  it("records scraped counts and marks the row completed", () => {
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("hiringcafe", 0, 1, {
      platforms: ["hiringcafe"],
    });
    progressHelpers.recordSourceJobsCounts("hiringcafe", {
      scraped: 17,
    });
    progressHelpers.markSourceCompleted("hiringcafe");

    const row = getProgress().sourceStats.find((r) => r.id === "hiringcafe");
    expect(row?.status).toBe("completed");
    expect(row?.jobsScraped).toBe(17);
    expect(row?.completedAt).toBeDefined();
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks failed sources with the error message", () => {
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("workingnomads", 0, 1, {
      platforms: ["workingnomads"],
    });
    progressHelpers.markSourceFailed("workingnomads", "boom: timeout");

    const row = getProgress().sourceStats.find(
      (r) => r.id === "workingnomads",
    );
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("boom: timeout");
    expect(row?.completedAt).toBeDefined();
  });

  it("attributes imports + reposts + duplicates + rejects per source", () => {
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("hiringcafe", 0, 1, {
      platforms: ["hiringcafe"],
    });
    progressHelpers.recordSourceJobsImported("hiringcafe", {
      imported: 5,
      reposted: 2,
      duplicated: 9,
      rejected: 1,
    });

    const row = getProgress().sourceStats.find((r) => r.id === "hiringcafe");
    expect(row?.jobsImported).toBe(5);
    expect(row?.jobsReposted).toBe(2);
    expect(row?.jobsDuplicated).toBe(9);
    expect(row?.jobsRejected).toBe(1);
  });

  it("records per-source filtered (dropped-before-import) counts", () => {
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("hiringcafe", 0, 1, {
      platforms: ["hiringcafe"],
    });
    progressHelpers.recordSourceJobsFiltered("hiringcafe", 4);

    const row = getProgress().sourceStats.find((r) => r.id === "hiringcafe");
    expect(row?.jobsFiltered).toBe(4);
  });

  it("recordSourceJobsCounts is a no-op when the row does not exist yet", () => {
    progressHelpers.startCrawling(1);
    // Notably no startSource call.
    progressHelpers.recordSourceJobsCounts("hiringcafe", { scraped: 99 });
    expect(getProgress().sourceStats).toEqual([]);
  });

  it("sweeps in-flight rows to failed when the pipeline is cancelled", () => {
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("hiringcafe", 0, 1, {
      platforms: ["hiringcafe"],
    });
    progressHelpers.cancelled("user cancelled");

    const row = getProgress().sourceStats.find((r) => r.id === "hiringcafe");
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("user cancelled");
  });

  it("sweeps in-flight rows to completed when the pipeline succeeds", () => {
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("hiringcafe", 0, 1, {
      platforms: ["hiringcafe"],
    });
    progressHelpers.complete(0, 0);

    const row = getProgress().sourceStats.find((r) => r.id === "hiringcafe");
    expect(row?.status).toBe("completed");
  });

  it("notifies subscribers when source-state mutations occur", () => {
    const received: number[] = [];
    const unsubscribe = subscribeToProgress((snapshot) => {
      received.push(snapshot.sourceStats.length);
    });

    progressHelpers.startCrawling(1);
    progressHelpers.startSource("hiringcafe", 0, 1, {
      platforms: ["hiringcafe"],
    });
    progressHelpers.markSourceCompleted("hiringcafe");

    unsubscribe();

    // At least one snapshot included the newly-created row.
    expect(Math.max(...received)).toBe(1);
  });
});

describe("per-profile funnel pages", () => {
  const profile = (id: string, index: number, total = 2) => ({
    id,
    name: `Profile ${id}`,
    index,
    total,
  });

  /** What one profile of a chain does to progress state, start to finish. */
  function runProfile(source: string, scraped: number) {
    // Every profile runs its own `runPipeline`, which resets progress first —
    // that reset is exactly what used to destroy the previous profile's table.
    resetProgress();
    progressHelpers.startCrawling(1);
    progressHelpers.startSource(source, 0, 1, { platforms: [source] });
    progressHelpers.recordSourceJobsCounts(source, { scraped });
    progressHelpers.complete(scraped, 0);
  }

  beforeEach(() => {
    setActiveProfileRun(null);
    resetProfileRunStats();
    resetProgress();
  });

  afterEach(() => {
    setActiveProfileRun(null);
    resetProfileRunStats();
    resetProgress();
  });

  it("keeps one page per profile instead of overwriting the table", () => {
    setActiveProfileRun(profile("a", 1));
    runProfile("hiringcafe", 7);
    setActiveProfileRun(profile("b", 2));
    runProfile("workingnomads", 3);

    const pages = getProgress().profileRuns ?? [];
    expect(pages.map((page) => page.profile.id)).toEqual(["a", "b"]);
    expect(pages[0]?.sourceStats.map((row) => row.id)).toEqual(["hiringcafe"]);
    expect(pages[0]?.sourceStats[0]?.jobsScraped).toBe(7);
    // The live rows only ever hold the profile that is running.
    expect(getProgress().sourceStats.map((row) => row.id)).toEqual([
      "workingnomads",
    ]);
  });

  it("retains a failed source's error on its own page", () => {
    setActiveProfileRun(profile("a", 1));
    resetProgress();
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("hiringcafe", 0, 1, {
      platforms: ["hiringcafe"],
    });
    progressHelpers.markSourceFailed("hiringcafe", "429 from upstream");
    progressHelpers.complete(0, 0);

    setActiveProfileRun(profile("b", 2));
    runProfile("workingnomads", 1);

    const pageA = (getProgress().profileRuns ?? [])[0];
    expect(pageA?.sourceStats[0]).toMatchObject({
      status: "failed",
      error: "429 from upstream",
    });
  });

  it("gives a profile its own empty page rather than the previous one's rows", () => {
    setActiveProfileRun(profile("a", 1));
    runProfile("hiringcafe", 5);
    // A profile the singleton guard rejects never resets or emits anything, so
    // the live rows still belong to the profile before it.
    setActiveProfileRun(profile("b", 2));
    setActiveProfileRun(null);
    progressHelpers.sequenceFinished({
      status: "completed",
      message: "Multi-profile run complete (1/2 profiles)",
      detail: "1 of 2 profiles completed, 1 failed",
    });

    const pages = getProgress().profileRuns ?? [];
    expect(pages[1]?.profile.id).toBe("b");
    expect(pages[1]?.sourceStats).toEqual([]);
    expect(pages[0]?.sourceStats.map((row) => row.id)).toEqual(["hiringcafe"]);
  });

  it("drops the pages when a run outside a chain starts", () => {
    setActiveProfileRun(profile("a", 1));
    runProfile("hiringcafe", 5);
    setActiveProfileRun(null);

    resetProgress();

    expect(getProgress().profileRuns).toEqual([]);
  });

  it("keeps the pages across each profile's own reset inside the chain", () => {
    setActiveProfileRun(profile("a", 1));
    runProfile("hiringcafe", 5);
    setActiveProfileRun(profile("b", 2));
    // The reset at the head of profile b's run must not take page a with it.
    resetProgress();

    expect((getProgress().profileRuns ?? []).map((p) => p.profile.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("per-source re-run aimed at one page", () => {
  const profile = (id: string, index: number, total = 2) => ({
    id,
    name: `Profile ${id}`,
    index,
    total,
  });

  /**
   * A finished two-profile chain. Profile a scraped Working Nomads fine and had
   * Hiring Cafe fail; profile b ran clean. The live rows therefore belong to
   * profile b — which is exactly what a re-run aimed at page a must not use.
   */
  function runFinishedChain() {
    setActiveProfileRun(profile("a", 1));
    resetProgress();
    progressHelpers.startCrawling(2);
    progressHelpers.startSource("workingnomads", 0, 2, {
      platforms: ["workingnomads"],
    });
    progressHelpers.recordSourceJobsCounts("workingnomads", { scraped: 3 });
    progressHelpers.markSourceCompleted("workingnomads");
    progressHelpers.startSource("hiringcafe", 1, 2, {
      platforms: ["hiringcafe"],
    });
    progressHelpers.markSourceFailed("hiringcafe", "429 from upstream");
    progressHelpers.complete(3, 0);

    setActiveProfileRun(profile("b", 2));
    resetProgress();
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("startupjobs", 0, 1, {
      platforms: ["startupjobs"],
    });
    progressHelpers.recordSourceJobsCounts("startupjobs", { scraped: 9 });
    progressHelpers.complete(9, 0);

    setActiveProfileRun(null);
    progressHelpers.sequenceFinished({
      status: "completed",
      message: "Multi-profile run complete (2/2 profiles)",
      detail: "2 of 2 profiles completed",
    });
  }

  /** What a per-source re-run does to progress state, start to finish. */
  function rerunSource(source: string, scraped: number) {
    resetProgress({ preserveSourceStats: true });
    progressHelpers.startCrawling(1, { preserveSourceStats: true });
    progressHelpers.startSource(source, 0, 1, { platforms: [source] });
    progressHelpers.recordSourceJobsCounts(source, { scraped });
    progressHelpers.markSourceCompleted(source);
    progressHelpers.complete(scraped, 0);
  }

  beforeEach(() => {
    setActiveProfileRun(null);
    resetProfileRunStats();
    resetProgress();
  });

  afterEach(() => {
    setActiveProfileRun(null);
    resetProfileRunStats();
    resetProgress();
  });

  it("reconciles into the page it was fired from, not the profile that ran last", () => {
    runFinishedChain();

    expect(targetProfileRunPage("a")).toBe(true);
    rerunSource("hiringcafe", 11);

    const pages = getProgress().profileRuns ?? [];
    expect(pages.map((page) => page.profile.id)).toEqual(["a", "b"]);
    // The re-run source refreshes in place: new counts, failure cleared. Rows
    // keep the banner's fixed platform order, not the order they ran in.
    expect(pages[0]?.sourceStats).toEqual([
      expect.objectContaining({
        id: "hiringcafe",
        status: "completed",
        jobsScraped: 11,
        error: undefined,
      }),
      expect.objectContaining({ id: "workingnomads", jobsScraped: 3 }),
    ]);
    // …and the page it was NOT fired from is left exactly as the chain left it.
    expect(pages[1]?.sourceStats).toEqual([
      expect.objectContaining({ id: "startupjobs", jobsScraped: 9 }),
    ]);
  });

  it("leaves its events untagged, so its terminal ends the run", () => {
    runFinishedChain();
    targetProfileRunPage("a");

    // `profileRun` is the client's "a chain is still going" signal. A re-run is
    // the whole run, so a tagged terminal here would hang the client forever.
    resetProgress({ preserveSourceStats: true });
    expect(getProgress().profileRun).toBeNull();
    progressHelpers.startCrawling(1, { preserveSourceStats: true });
    expect(getProgress().profileRun).toBeNull();
    progressHelpers.complete(0, 0);
    expect(getProgress().profileRun).toBeNull();
    expect(getProgress().step).toBe("completed");
  });

  it("declines a profile that has no page and leaves the funnel alone", () => {
    runFinishedChain();

    expect(targetProfileRunPage("never-ran")).toBe(false);
    expect(getProgress().sourceStats.map((row) => row.id)).toEqual([
      "startupjobs",
    ]);
  });

  it("gives the pages back up once the re-run that held them is done", () => {
    runFinishedChain();
    targetProfileRunPage("a");
    rerunSource("hiringcafe", 1);
    clearProfileRunPageTarget();

    // The next ordinary run owns the whole banner again.
    resetProgress();
    expect(getProgress().profileRuns).toEqual([]);
  });
});
