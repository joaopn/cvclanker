// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearProfileRunPageTarget,
  dismissRunBanner,
  getProgress,
  progressHelpers,
  resetProfileRunStats,
  resetProgress,
  setActiveProfileRun,
  setActiveRunTrigger,
  subscribeToProgress,
  targetProfileRunPage,
  updateProgress,
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

/**
 * The banner describes the RUN, not the browser looking at it. Closing a window
 * used to be indistinguishable from dismissing the banner, and reopening the
 * page resurrected one already dealt with — or, worse, showed nothing at all
 * for a run that had ended while nobody was watching.
 */
describe("run banner dismissal", () => {
  beforeEach(() => {
    resetProgress();
  });

  it("starts undismissed", () => {
    expect(getProgress().dismissed).toBe(false);
  });

  it("is visible to every subscriber, including ones that connect later", () => {
    updateProgress({ step: "failed", message: "Pipeline failed" });
    dismissRunBanner();

    // What a newly-opened tab receives on connect.
    const replayed: boolean[] = [];
    const unsubscribe = subscribeToProgress((progress) => {
      replayed.push(progress.dismissed);
    });
    unsubscribe();

    expect(replayed).toEqual([true]);
  });

  it("notifies the tabs already watching", () => {
    updateProgress({ step: "failed", message: "Pipeline failed" });
    const seen: boolean[] = [];
    const unsubscribe = subscribeToProgress((progress) => {
      seen.push(progress.dismissed);
    });

    dismissRunBanner();
    unsubscribe();

    // The replay on subscribe, then the dismissal — so a second tab hides the
    // banner without being clicked.
    expect(seen).toEqual([false, true]);
  });

  it("does not notify twice for the same dismissal", () => {
    dismissRunBanner();
    const seen: boolean[] = [];
    const unsubscribe = subscribeToProgress((progress) => {
      seen.push(progress.dismissed);
    });

    dismissRunBanner();
    unsubscribe();

    expect(seen).toEqual([true]);
  });

  it("clears when the next run starts", () => {
    updateProgress({ step: "failed", message: "Pipeline failed" });
    dismissRunBanner();
    expect(getProgress().dismissed).toBe(true);

    resetProgress();

    // Whoever dismissed the last banner was dismissing THAT run, not muting
    // every run after it.
    expect(getProgress().dismissed).toBe(false);
  });

  /**
   * `resetProgress` runs once per PROFILE, but a chain is ONE banner to the
   * user. Clearing dismissal there would pop the banner back at every leg of a
   * chain they had already hidden.
   */
  it("survives the per-profile resets inside a chain", () => {
    setActiveProfileRun({ id: "p1", name: "First", index: 1, total: 2 });
    updateProgress({ step: "scoring", message: "Scoring" });
    dismissRunBanner();

    // The next leg of the same chain.
    setActiveProfileRun({ id: "p2", name: "Second", index: 2, total: 2 });
    resetProgress();

    expect(getProgress().dismissed).toBe(true);
  });

  it("clears when a NEW chain starts", () => {
    setActiveProfileRun({ id: "p1", name: "First", index: 1, total: 2 });
    updateProgress({ step: "scoring", message: "Scoring" });
    dismissRunBanner();

    resetProfileRunStats();

    expect(getProgress().dismissed).toBe(false);
  });

  /**
   * A tab left open on yesterday's failed run still shows a Dismiss button. If
   * a new run starts before it is pressed, an unqualified dismissal would hide
   * the LIVE run from every viewer, with nothing to clear it until the run
   * after that.
   */
  it("ignores a dismissal naming a run the server has moved past", () => {
    updateProgress({
      step: "failed",
      message: "Pipeline failed",
      startedAt: "2026-05-22T10:00:00.000Z",
    });
    resetProgress();
    updateProgress({
      step: "crawling",
      message: "Fetching",
      startedAt: "2026-05-22T12:00:00.000Z",
    });

    dismissRunBanner("2026-05-22T10:00:00.000Z");

    expect(getProgress().dismissed).toBe(false);
  });

  it("applies a dismissal naming the run it is looking at", () => {
    updateProgress({
      step: "failed",
      message: "Pipeline failed",
      startedAt: "2026-05-22T12:00:00.000Z",
    });

    dismissRunBanner("2026-05-22T12:00:00.000Z");

    expect(getProgress().dismissed).toBe(true);
  });

  it("survives an update to the run it describes", () => {
    dismissRunBanner();
    updateProgress({ step: "scoring", message: "Scoring jobs" });

    // A dismissed run going on emitting must not un-hide itself.
    expect(getProgress().dismissed).toBe(true);
  });
});

describe("manual and scheduled runs keep separate tables", () => {
  /** One whole run of a given kind, start to terminal. */
  function runOnce(
    trigger: "manual" | "schedule",
    source: string,
    scraped: number,
    startedAt?: string,
  ) {
    setActiveRunTrigger(trigger);
    resetProgress();
    progressHelpers.startCrawling(1);
    // Stamped explicitly: two runs built synchronously in a test share a
    // millisecond, where real runs are minutes or hours apart.
    if (startedAt) updateProgress({ startedAt });
    progressHelpers.startSource(source, 0, 1, { platforms: [source] });
    progressHelpers.recordSourceJobsCounts(source, { scraped });
    progressHelpers.complete(scraped, 0);
  }

  function reset() {
    for (const trigger of ["manual", "schedule"] as const) {
      setActiveRunTrigger(trigger);
      setActiveProfileRun(null);
      resetProfileRunStats();
      resetProgress();
    }
    setActiveRunTrigger("manual");
  }

  beforeEach(reset);
  afterEach(reset);

  it("stamps every event with the partition holding it", () => {
    runOnce("manual", "hiringcafe", 3);
    expect(getProgress("manual").trigger).toBe("manual");

    runOnce("schedule", "workingnomads", 5);
    expect(getProgress("schedule").trigger).toBe("schedule");
  });

  it("will not let an update claim a partition other than its own", () => {
    setActiveRunTrigger("manual");
    resetProgress();
    // The stamp is applied AFTER the caller's fields are spread in, so an event
    // can never claim a table it is not stored in.
    updateProgress({ trigger: "schedule", message: "spoofed" });

    expect(getProgress("manual").trigger).toBe("manual");
    expect(getProgress("manual").message).toBe("spoofed");
    expect(getProgress("schedule").message).not.toBe("spoofed");
  });

  it("refuses a re-run aim taken for the other partition", () => {
    const profileRun = (id: string) => ({
      id,
      name: `Profile ${id}`,
      index: 1,
      total: 1,
    });

    setActiveRunTrigger("schedule");
    resetProfileRunStats();
    setActiveProfileRun(profileRun("scheduled-profile"));
    runOnce("schedule", "workingnomads", 11);
    setActiveProfileRun(null);

    // Aim at the SCHEDULE table's page, then run as manual: the aim belongs to
    // a partition this run is not filling, so it must not be consumed.
    expect(targetProfileRunPage("scheduled-profile", "schedule")).toBe(true);

    setActiveRunTrigger("manual");
    resetProgress();
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("hiringcafe", 0, 1, {
      platforms: ["hiringcafe"],
    });
    progressHelpers.complete(1, 0);

    expect(getProgress("manual").profileRuns ?? []).toEqual([]);

    clearProfileRunPageTarget();
  });

  it("leaves the retained manual table untouched when a scheduled run happens", () => {
    runOnce("manual", "hiringcafe", 3);
    const before = getProgress("manual");

    runOnce("schedule", "workingnomads", 11);

    expect(getProgress("manual")).toEqual(before);
    // ...and the schedule slot really did record its own, different run.
    expect(
      getProgress("schedule").sourceStats.map((row) => [
        row.id,
        row.jobsScraped,
      ]),
    ).toEqual([["workingnomads", 11]]);
  });

  it("rebuilds a per-source re-run's funnel from ITS OWN table, not the run that happened in between", () => {
    // The regression this partition exists to prevent: a per-source re-run
    // preserves the existing funnel rows rather than starting from zero, which
    // is a carry-over ACROSS runs. Sharing one live map would hand the manual
    // re-run whatever the scheduled run left behind.
    runOnce("manual", "hiringcafe", 3);
    runOnce("schedule", "workingnomads", 11);

    setActiveRunTrigger("manual");
    resetProgress({ preserveSourceStats: true });

    expect(getProgress("manual").sourceStats.map((row) => row.id)).toEqual([
      "hiringcafe",
    ]);
  });

  it("dismisses one table without hiding the other", () => {
    runOnce("manual", "hiringcafe", 3, "2026-08-29T09:00:00.000Z");
    runOnce("schedule", "workingnomads", 11, "2026-08-29T10:00:00.000Z");

    dismissRunBanner("2026-08-29T09:00:00.000Z", "manual");

    expect(getProgress("manual").dismissed).toBe(true);
    expect(getProgress("schedule").dismissed).toBe(false);

    dismissRunBanner("2026-08-29T10:00:00.000Z", "schedule");
    expect(getProgress("schedule").dismissed).toBe(true);
  });

  it("applies a dismissal to the table it names, not to the run that went last", () => {
    runOnce("manual", "hiringcafe", 3, "2026-08-29T09:00:00.000Z");
    runOnce("schedule", "workingnomads", 11, "2026-08-29T10:00:00.000Z");
    runOnce("manual", "hiringcafe", 4, "2026-08-29T11:00:00.000Z");

    // The scheduled run is neither the active partition nor the latest run, and
    // the timestamp matches nothing in the manual table.
    dismissRunBanner("2026-08-29T10:00:00.000Z", "schedule");

    expect(getProgress("schedule").dismissed).toBe(true);
    expect(getProgress("manual").dismissed).toBe(false);
  });

  it("carries no crawl detail across from the other table", () => {
    runOnce("manual", "hiringcafe", 3);
    progressHelpers.crawlingUpdate({
      source: "hiringcafe",
      phase: "job",
      currentUrl: "https://example.com/manual-run",
    });

    setActiveRunTrigger("schedule");
    resetProgress();
    progressHelpers.startCrawling(1);
    progressHelpers.startSource("workingnomads", 0, 1, {
      platforms: ["workingnomads"],
    });
    // No phase or URL of its own: both are optional on the extractor event, so
    // whatever this update omits must come from the SCHEDULE table, not from
    // the manual one still on screen.
    progressHelpers.crawlingUpdate({
      source: "workingnomads",
      listPagesProcessed: 1,
    });

    expect(getProgress("schedule").crawlingCurrentUrl).toBeUndefined();
    expect(getProgress("schedule").crawlingPhase).toBeUndefined();
  });

  it("keeps each partition's retained profile pages apart", () => {
    const profileRun = (id: string) => ({
      id,
      name: `Profile ${id}`,
      index: 1,
      total: 1,
    });

    setActiveRunTrigger("manual");
    resetProfileRunStats();
    setActiveProfileRun(profileRun("manual-profile"));
    runOnce("manual", "hiringcafe", 3);
    // Mirrors `runProfileSequence`'s finally: the active profile is module-wide
    // (it describes the run in flight, not a retained table) and the chain
    // clears it on the way out.
    setActiveProfileRun(null);

    setActiveRunTrigger("schedule");
    resetProfileRunStats();
    setActiveProfileRun(profileRun("scheduled-profile"));
    runOnce("schedule", "workingnomads", 11);
    setActiveProfileRun(null);

    // Re-emit on manual: `profileRuns` is frozen into each slot at emit time,
    // so asserting the snapshot taken before the scheduled run would pass even
    // if both partitions shared one pages map.
    setActiveRunTrigger("manual");
    updateProgress({});

    expect(
      getProgress("manual").profileRuns?.map((page) => page.profile.id),
    ).toEqual(["manual-profile"]);
    expect(
      getProgress("schedule").profileRuns?.map((page) => page.profile.id),
    ).toEqual(["scheduled-profile"]);
  });

  it("aims a re-run at a page of the partition it names, not the active one", () => {
    const profileRun = (id: string) => ({
      id,
      name: `Profile ${id}`,
      index: 1,
      total: 1,
    });

    setActiveRunTrigger("manual");
    resetProfileRunStats();
    setActiveProfileRun(profileRun("manual-profile"));
    runOnce("manual", "hiringcafe", 3);
    setActiveProfileRun(null);

    // A scheduled run goes last, so the ambient trigger is "schedule" when the
    // route (which fires while nothing is running) aims the re-run.
    runOnce("schedule", "workingnomads", 11);

    expect(targetProfileRunPage("manual-profile", "manual")).toBe(true);
    expect(targetProfileRunPage("manual-profile", "schedule")).toBe(false);

    clearProfileRunPageTarget();
  });

  it("replays only the manual table to a new subscriber", () => {
    runOnce("schedule", "workingnomads", 11);

    const seen: string[] = [];
    const unsubscribe = subscribeToProgress((progress) => {
      seen.push(progress.trigger);
    });
    unsubscribe();

    // Every client consumer is still last-event-wins over one feed, so a
    // pristine schedule slot replayed after a live manual event would blank the
    // banner. Replaying both is the client slice's job.
    expect(seen).toEqual(["manual"]);
  });
});
