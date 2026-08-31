// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobOutcome, JobStatus, SuitabilityCategory } from "@shared/types";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StatsRepo = Awaited<typeof import("./stats")>;

type SeedJob = {
  id: string;
  status?: JobStatus;
  suitability?: SuitabilityCategory | null;
  discoveredAt?: string;
  appliedAt?: string | null;
  closedAt?: number | null;
  readyAt?: string | null;
  outcome?: JobOutcome | null;
  employer?: string;
  source?: string;
  profileId?: string | null;
  repostCount?: number;
  liveClosed?: boolean | null;
  liveStatusCheckedAt?: string | null;
};

const ALL_TIME = { sinceDays: null, profileId: null } as const;

/** Start of the UTC day containing `date`. */
function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

describe.sequential("stats repository", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let stats: StatsRepo;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-stats-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
    ({ db, schema } = await import("../db/index"));
    stats = await import("./stats");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const seed = (job: SeedJob) =>
    db.insert(schema.jobs).values({
      id: job.id,
      source: job.source ?? "linkedin",
      title: `Job ${job.id}`,
      employer: job.employer ?? "Acme",
      jobUrl: `https://example.com/${job.id}`,
      status: job.status ?? "discovered",
      suitabilityCategory: job.suitability ?? null,
      discoveredAt: job.discoveredAt ?? new Date().toISOString(),
      appliedAt: job.appliedAt ?? null,
      closedAt: job.closedAt ?? null,
      readyAt: job.readyAt ?? null,
      outcome: job.outcome ?? null,
      profileId: job.profileId ?? null,
      repostCount: job.repostCount ?? 0,
      liveClosed: job.liveClosed ?? null,
      liveStatusCheckedAt: job.liveStatusCheckedAt ?? null,
    });

  describe("empty database", () => {
    it("returns zeros rather than throwing", async () => {
      const overview = await stats.getOverviewStats(ALL_TIME);
      expect(overview.found).toBe(0);
      expect(overview.scored).toBe(0);
      expect(overview.activity).toEqual([]);
      expect(overview.calibration).toHaveLength(5);
      expect(overview.calibration.every((row) => row.total === 0)).toBe(true);

      const applications = await stats.getApplicationStats(ALL_TIME);
      expect(applications.applied).toBe(0);
      expect(applications.medianReplyDays).toBeNull();

      const companies = await stats.getCompanyStats(ALL_TIME);
      expect(companies.companies).toEqual([]);

      const discovery = await stats.getDiscoveryStats(ALL_TIME);
      expect(discovery.sources).toEqual([]);
      expect(discovery.termAttributionAvailable).toBe(false);
    });
  });

  describe("range filter", () => {
    /**
     * The regression guard for the lexical-comparison trap. `discovered_at`
     * holds ISO text with a `T`, while `datetime('now', '-N days')` is
     * space-separated, and SQLite compares TEXT lexically — so a row on the
     * SAME UTC date as the cutoff but hours EARLIER compares greater ('T' is
     * 0x54, space is 0x20) and is wrongly included.
     *
     * The fixture is therefore pinned to the start of the cutoff's own UTC day:
     * it always shares the cutoff's date part, so removing the `datetime()`
     * wrapping in `withinRange` must turn this test red.
     */
    it("excludes a row earlier the same UTC day as the cutoff", async () => {
      const sinceDays = 7;
      const cutoff = new Date(Date.now() - sinceDays * 86_400_000);
      const sameDayButEarlier = startOfUtcDay(cutoff);

      await seed({
        id: "before",
        discoveredAt: sameDayButEarlier.toISOString(),
      });
      await seed({
        id: "after",
        discoveredAt: new Date(cutoff.getTime() + 3_600_000).toISOString(),
      });

      const overview = await stats.getOverviewStats({
        sinceDays,
        profileId: null,
      });
      expect(overview.found).toBe(1);
    });

    it("counts everything when sinceDays is null", async () => {
      await seed({
        id: "ancient",
        discoveredAt: new Date(Date.now() - 900 * 86_400_000).toISOString(),
      });
      const overview = await stats.getOverviewStats(ALL_TIME);
      expect(overview.found).toBe(1);
    });

    it("applies the applications range to applied_at, not discovered_at", async () => {
      // Found long ago, applied today: in range for Applications.
      await seed({
        id: "late-apply",
        status: "applied",
        discoveredAt: new Date(Date.now() - 300 * 86_400_000).toISOString(),
        appliedAt: new Date().toISOString(),
      });
      const applications = await stats.getApplicationStats({
        sinceDays: 30,
        profileId: null,
      });
      expect(applications.applied).toBe(1);
    });
  });

  describe("scoring buckets", () => {
    it("counts unscored rows through an IS NULL arm", async () => {
      await seed({ id: "a", suitability: null });
      await seed({ id: "b", suitability: "bad_fit" });
      await seed({ id: "c", suitability: "good_fit" });

      const overview = await stats.getOverviewStats(ALL_TIME);
      expect(overview.found).toBe(3);
      expect(overview.scored).toBe(2);
      expect(overview.unscored).toBe(1);
      expect(overview.goodFit).toBe(1);

      const unscoredRow = overview.calibration.find(
        (row) => row.category === "unscored",
      );
      expect(unscoredRow?.total).toBe(1);
    });

    it("treats every good tier as good fit", async () => {
      await seed({ id: "a", suitability: "good_fit" });
      await seed({ id: "b", suitability: "very_good_fit" });
      await seed({ id: "c", suitability: "great_fit" });
      await seed({ id: "d", suitability: "bad_fit" });

      const overview = await stats.getOverviewStats(ALL_TIME);
      expect(overview.goodFit).toBe(3);
    });
  });

  describe("calibration crosstab", () => {
    it("partitions each tier into mutually exclusive buckets", async () => {
      await seed({ id: "skipped", suitability: "good_fit", status: "skipped" });
      await seed({
        id: "tailored",
        suitability: "good_fit",
        readyAt: new Date().toISOString(),
      });
      await seed({
        id: "closed",
        suitability: "good_fit",
        status: "closed",
        outcome: "duplicated",
      });
      await seed({ id: "inbox", suitability: "good_fit" });

      const row = (await stats.getOverviewStats(ALL_TIME)).calibration.find(
        (entry) => entry.category === "good_fit",
      );
      expect(row).toMatchObject({
        skipped: 1,
        tailored: 1,
        closed: 1,
        inInbox: 1,
        total: 4,
      });
    });

    it("credits an applied-but-never-tailored job to applied, not the inbox", async () => {
      // The apply route writes `status` only and never stamps ready_at, so this
      // is the ordinary shape of a job applied to straight from the inbox.
      await seed({
        id: "applied",
        suitability: "good_fit",
        status: "applied",
        appliedAt: new Date().toISOString(),
      });

      const row = (await stats.getOverviewStats(ALL_TIME)).calibration.find(
        (entry) => entry.category === "good_fit",
      );
      expect(row).toMatchObject({ applied: 1, inInbox: 0, tailored: 0 });
    });

    it("counts a tailored-then-skipped row as skipped, the later decision", async () => {
      await seed({
        id: "both",
        suitability: "good_fit",
        status: "skipped",
        readyAt: new Date().toISOString(),
      });
      const row = (await stats.getOverviewStats(ALL_TIME)).calibration.find(
        (entry) => entry.category === "good_fit",
      );
      expect(row).toMatchObject({ skipped: 1, tailored: 0, total: 1 });
    });
  });

  describe("application buckets", () => {
    it("partitions the applied set exactly, residual included", async () => {
      const now = new Date().toISOString();
      await seed({ id: "waiting", status: "applied", appliedAt: now });
      await seed({
        id: "advanced",
        status: "in_progress",
        appliedAt: now,
      });
      await seed({
        id: "rejected",
        status: "closed",
        outcome: "rejected",
        appliedAt: now,
        closedAt: Math.floor(Date.now() / 1000),
      });
      // Reopened: `reopen` clears outcome and closed_at but KEEPS applied_at,
      // so this row is an application in no application state.
      await seed({ id: "reopened", status: "discovered", appliedAt: now });
      // Swept out of Tailoring, still carrying its applied mark.
      await seed({ id: "swept", status: "stale", appliedAt: now });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.applied).toBe(5);
      expect(result.stillWaiting).toBe(1);
      expect(result.advanced).toBe(1);
      expect(result.rejected).toBe(1);
      expect(result.movedOn).toBe(2);

      // Counted independently of the CASE, so this catches the buckets and the
      // reported total drifting apart — which asserting against `result.applied`
      // alone cannot, since that figure is itself the sum of the buckets.
      const [independent] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.jobs)
        .where(sql`applied_at is not null`);

      const partitioned =
        result.rejected +
        result.advanced +
        result.ghostedRecorded +
        result.ghostedDerived +
        result.stillWaiting +
        result.closedOther +
        result.movedOn;
      expect(partitioned).toBe(independent?.count);
      expect(result.applied).toBe(independent?.count);
    });

    it("routes a withdrawn or duplicated closure to closedOther, not movedOn", async () => {
      const now = new Date().toISOString();
      await seed({
        id: "withdrawn",
        status: "closed",
        outcome: "withdrawn",
        appliedAt: now,
      });
      await seed({
        id: "dup",
        status: "closed",
        outcome: "duplicated",
        appliedAt: now,
      });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.closedOther).toBe(2);
      expect(result.movedOn).toBe(0);
      expect(result.heardBack).toBe(0);
    });

    it("counts a stage switch back to Tailoring as moved on", async () => {
      // JobStageSwitcher offers applied -> ready directly, which keeps the
      // applied mark on a row that is no longer an open application.
      await seed({
        id: "back-to-ready",
        status: "ready",
        appliedAt: new Date().toISOString(),
      });
      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.movedOn).toBe(1);
      expect(result.stillWaiting).toBe(0);
    });

    it("counts an outcome written without a status change", async () => {
      // PATCH /:id/outcome writes outcome + closed_at and does NOT touch
      // status, so this state is reachable through the API.
      await seed({
        id: "outcome-only",
        status: "applied",
        outcome: "rejected",
        appliedAt: new Date().toISOString(),
        closedAt: Math.floor(Date.now() / 1000),
      });
      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.rejected).toBe(1);
      expect(result.stillWaiting).toBe(0);
    });

    it("separates a recorded ghosting from a derived one", async () => {
      const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
      await seed({
        id: "recorded",
        status: "closed",
        outcome: "ghosted",
        appliedAt: old,
      });
      await seed({ id: "derived", status: "applied", appliedAt: old });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.ghostedRecorded).toBe(1);
      expect(result.ghostedDerived).toBe(1);
    });

    it("keeps a fresh application out of the derived-ghost bucket", async () => {
      // Offset derived from the clock so the boundary lands mid-window rather
      // than at whatever time the suite happens to run (the B20 flake).
      const fresh = new Date(Date.now() - 2 * 86_400_000).toISOString();
      await seed({ id: "fresh", status: "applied", appliedAt: fresh });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.stillWaiting).toBe(1);
      expect(result.ghostedDerived).toBe(0);
    });
  });

  describe("reply time", () => {
    it("measures closed applications in days", async () => {
      const appliedAt = new Date(Date.now() - 10 * 86_400_000);
      await seed({
        id: "closed",
        status: "closed",
        outcome: "rejected",
        appliedAt: appliedAt.toISOString(),
        closedAt: Math.floor((appliedAt.getTime() + 6 * 86_400_000) / 1000),
      });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.replyTimeSampleSize).toBe(1);
      expect(result.medianReplyDays).toBe(6);
      const bucket = result.replyTimeBuckets.find((b) => b.key === "4-7");
      expect(bucket?.count).toBe(1);
    });

    it("drops a millisecond-valued closed_at instead of counting a 56,000-year reply", async () => {
      const appliedAt = new Date(Date.now() - 5 * 86_400_000);
      await seed({
        id: "legacy-ms",
        status: "closed",
        outcome: "rejected",
        appliedAt: appliedAt.toISOString(),
        // Milliseconds where seconds belong: datetime(..., 'unixepoch') is out
        // of SQLite's supported range and yields NULL.
        closedAt: Date.now(),
      });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.replyTimeSampleSize).toBe(0);
      expect(result.medianReplyDays).toBeNull();
    });

    it("drops a closure recorded before the application", async () => {
      const appliedAt = new Date();
      await seed({
        id: "negative",
        status: "closed",
        outcome: "rejected",
        appliedAt: appliedAt.toISOString(),
        closedAt: Math.floor((appliedAt.getTime() - 5 * 86_400_000) / 1000),
      });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.replyTimeSampleSize).toBe(0);
    });

    it("ignores an advance, which has no transition timestamp", async () => {
      await seed({
        id: "advanced",
        status: "in_progress",
        appliedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      });
      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.advanced).toBe(1);
      expect(result.replyTimeSampleSize).toBe(0);
    });

    it("lists outstanding applications oldest first", async () => {
      await seed({
        id: "newer",
        status: "applied",
        appliedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      });
      await seed({
        id: "older",
        status: "applied",
        appliedAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.outstanding.map((row) => row.id)).toEqual([
        "older",
        "newer",
      ]);
      expect(result.outstanding[0]?.daysWaiting).toBe(9);
    });

    it("includes the derived ghosts the list is oldest-first about", async () => {
      // The regression this pins: the list is ordered oldest-first, so scoping
      // it to `stillWaiting` would return the ghosts' slots filled by nobody —
      // a list of rows none of which the count beside it refers to.
      await seed({
        id: "ghosted",
        status: "applied",
        appliedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      });
      await seed({
        id: "fresh",
        status: "applied",
        appliedAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
      });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.stillWaiting).toBe(1);
      expect(result.ghostedDerived).toBe(1);
      expect(result.outstanding.map((row) => row.id)).toEqual([
        "ghosted",
        "fresh",
      ]);
      expect(result.outstandingTotal).toBe(2);
    });

    it("caps the outstanding list and reports the uncapped total", async () => {
      for (let index = 0; index < 22; index += 1) {
        await seed({
          id: `w${index}`,
          status: "applied",
          appliedAt: new Date(
            Date.now() - (index + 1) * 3_600_000,
          ).toISOString(),
        });
      }
      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.outstanding).toHaveLength(20);
      expect(result.outstandingTotal).toBe(22);
    });

    it("drops an unparseable applied_at instead of heading the list with zero days", async () => {
      await seed({ id: "corrupt", status: "applied", appliedAt: "not-a-date" });
      await seed({
        id: "real",
        status: "applied",
        appliedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      });

      const result = await stats.getApplicationStats(ALL_TIME);
      expect(result.outstanding.map((row) => row.id)).toEqual(["real"]);
    });
  });

  describe("discovery", () => {
    it("groups by source and keeps an Apify instance distinct from its board", async () => {
      await seed({ id: "a", source: "linkedin", suitability: "good_fit" });
      await seed({ id: "b", source: "linkedin", suitability: "bad_fit" });
      await seed({
        id: "c",
        source: "apify:11111111-2222-3333-4444-555555555555",
        suitability: "bad_fit",
      });

      const discovery = await stats.getDiscoveryStats(ALL_TIME);
      const bySource = new Map(
        discovery.sources.map((row) => [row.source, row]),
      );
      expect(bySource.get("linkedin")).toMatchObject({ jobs: 2, goodFit: 1 });
      expect(
        bySource.get("apify:11111111-2222-3333-4444-555555555555"),
      ).toMatchObject({ jobs: 1, goodFit: 0 });
    });

    it("names an unattributed profile rather than dropping the rows", async () => {
      await seed({ id: "a", profileId: null });
      const discovery = await stats.getDiscoveryStats(ALL_TIME);
      expect(discovery.profiles).toEqual([
        { profileId: null, name: "Unattributed", jobs: 1, goodFit: 0 },
      ]);
    });

    it("resolves a known profile's name and filters by it", async () => {
      await db.insert(schema.profiles).values({
        id: "p1",
        name: "Remote",
        configJson: {},
      });
      await seed({ id: "a", profileId: "p1", suitability: "good_fit" });
      await seed({ id: "b", profileId: null });

      const all = await stats.getDiscoveryStats(ALL_TIME);
      expect(all.profiles.find((row) => row.profileId === "p1")?.name).toBe(
        "Remote",
      );

      const scoped = await stats.getOverviewStats({
        sinceDays: null,
        profileId: "p1",
      });
      expect(scoped.found).toBe(1);
      expect(scoped.goodFit).toBe(1);
    });
  });

  describe("activity series", () => {
    it("buckets by UTC day, in order, and counts each day", async () => {
      const day = (isoDate: string, time: string) => `${isoDate}T${time}Z`;
      await seed({ id: "a", discoveredAt: day("2026-08-10", "01:00:00.000") });
      await seed({ id: "b", discoveredAt: day("2026-08-10", "23:30:00.000") });
      await seed({ id: "c", discoveredAt: day("2026-08-12", "12:00:00.000") });

      const overview = await stats.getOverviewStats(ALL_TIME);
      expect(overview.activity).toEqual([
        { date: "2026-08-10", count: 2 },
        { date: "2026-08-12", count: 1 },
      ]);
    });

    it("reads a space-separated discovered_at, which the column default writes", async () => {
      // `discovered_at` has DEFAULT (datetime('now')), so the column can hold
      // the space-separated shape as well as the ISO one every insert path uses.
      await seed({ id: "a", discoveredAt: "2026-08-10 08:00:00" });
      const overview = await stats.getOverviewStats(ALL_TIME);
      expect(overview.activity).toEqual([{ date: "2026-08-10", count: 1 }]);
    });
  });

  describe("funnel", () => {
    it("reports every step, flagging which are subsets and which are permanent", async () => {
      await seed({ id: "a", suitability: "good_fit" });
      await seed({
        id: "b",
        suitability: "bad_fit",
        readyAt: new Date().toISOString(),
        appliedAt: new Date().toISOString(),
        status: "applied",
      });

      const { funnel } = await stats.getOverviewStats(ALL_TIME);
      expect(funnel.map((step) => step.key)).toEqual([
        "found",
        "scored",
        "good_fit",
        "tailored",
        "applied",
      ]);
      expect(funnel.map((step) => step.count)).toEqual([2, 2, 1, 1, 1]);
      // A bad-fit job that was tailored and applied to is why these two steps
      // are not subsets of the one above them.
      expect(funnel.find((step) => step.key === "tailored")?.nested).toBe(
        false,
      );
      expect(funnel.find((step) => step.key === "scored")?.nested).toBe(true);
      expect(funnel.find((step) => step.key === "scored")?.basis).toBe(
        "current",
      );
      expect(funnel.find((step) => step.key === "applied")?.basis).toBe(
        "permanent",
      );
    });
  });

  describe("combined filters", () => {
    it("intersects the profile and the range rather than applying one", async () => {
      await db.insert(schema.profiles).values({
        id: "p1",
        name: "Remote",
        configJson: {},
      });
      const old = new Date(Date.now() - 400 * 86_400_000).toISOString();

      await seed({ id: "in-both", profileId: "p1" });
      await seed({ id: "wrong-profile", profileId: null });
      await seed({ id: "too-old", profileId: "p1", discoveredAt: old });

      const overview = await stats.getOverviewStats({
        sinceDays: 30,
        profileId: "p1",
      });
      expect(overview.found).toBe(1);

      const discovery = await stats.getDiscoveryStats({
        sinceDays: 30,
        profileId: "p1",
      });
      expect(discovery.sources.reduce((sum, row) => sum + row.jobs, 0)).toBe(1);
    });
  });

  describe("source labels", () => {
    it("names each board rather than the scraper behind it", async () => {
      // resolveSourceDisplayLabel answers "jobspy" for linkedin, indeed AND
      // glassdoor alike, which in an aggregate table renders three rows under
      // one name. These are separate boards and must read as separate boards.
      await seed({ id: "a", source: "linkedin" });
      await seed({ id: "b", source: "indeed" });

      const discovery = await stats.getDiscoveryStats(ALL_TIME);
      const labels = discovery.sources.map((row) => row.label);
      expect(new Set(labels).size).toBe(2);
      expect(labels).toContain("LinkedIn");
      expect(labels).toContain("Indeed");
    });

    it("falls back to the raw id for a source it cannot name", async () => {
      await seed({ id: "a", source: "some-retired-board" });
      const discovery = await stats.getDiscoveryStats(ALL_TIME);
      expect(discovery.sources[0]?.label).toBe("some-retired-board");
    });
  });

  describe("deleted profiles", () => {
    it("keeps rows attributed to a deleted profile visible", async () => {
      await seed({ id: "a", profileId: "gone-forever" });
      const discovery = await stats.getDiscoveryStats(ALL_TIME);
      expect(discovery.profiles).toEqual([
        {
          profileId: "gone-forever",
          name: "Deleted profile",
          jobs: 1,
          goodFit: 0,
        },
      ]);
    });
  });

  describe("companies", () => {
    it("groups case-insensitively and labels the group with a real spelling", async () => {
      await seed({ id: "a", employer: "Canonical" });
      await seed({ id: "b", employer: "canonical" });

      const companies = await stats.getCompanyStats(ALL_TIME);
      expect(companies.companies).toHaveLength(1);
      expect(companies.companies[0]?.jobs).toBe(2);
      // Not a leading-space variant: the label is handed to the client as the
      // company's name and must be one of the spellings actually stored.
      expect(companies.companies[0]?.employer.trim()).toBe(
        companies.companies[0]?.employer,
      );
    });

    it("keeps a whitespace variant separate, matching the jobs-list filter exactly", async () => {
      // The jobs list filters on lower(employer) with NO trim, so trimming here
      // would report a count larger than the list the row opens.
      await seed({ id: "a", employer: "Canonical" });
      await seed({ id: "b", employer: " Canonical " });

      const companies = await stats.getCompanyStats(ALL_TIME);
      expect(companies.companies).toHaveLength(2);
    });

    it("ranks by good fit and reports its own cut", async () => {
      await seed({ id: "big", employer: "Volume Ltd", suitability: "bad_fit" });
      await seed({ id: "b2", employer: "Volume Ltd", suitability: "bad_fit" });
      await seed({
        id: "good",
        employer: "Signal Ltd",
        suitability: "good_fit",
      });

      const companies = await stats.getCompanyStats(ALL_TIME);
      expect(companies.companies[0]?.employer).toBe("Signal Ltd");
    });

    it("reports churn counters", async () => {
      await seed({
        id: "a",
        repostCount: 2,
        liveClosed: true,
        liveStatusCheckedAt: new Date().toISOString(),
      });
      await seed({ id: "b" });

      const companies = await stats.getCompanyStats(ALL_TIME);
      expect(companies.repostedJobs).toBe(1);
      expect(companies.liveClosedJobs).toBe(1);
      // A COUNT of rows carrying a verdict, never a share of totalJobs: only
      // LinkedIn-shaped rows are checkable at all.
      expect(companies.liveStatusChecked).toBe(1);
      expect(companies.totalJobs).toBe(2);
    });

    it("honours the range filter", async () => {
      await seed({
        id: "old",
        employer: "Old Co",
        discoveredAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      });
      await seed({ id: "new", employer: "New Co" });

      const companies = await stats.getCompanyStats({
        sinceDays: 30,
        profileId: null,
      });
      expect(companies.companies.map((row) => row.employer)).toEqual([
        "New Co",
      ]);
      expect(companies.totalJobs).toBe(1);
    });
  });
});
