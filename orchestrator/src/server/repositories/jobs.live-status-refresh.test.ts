// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStatus } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("getJobsForLiveStatusRefresh", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-live-refresh-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
    ({ db, schema } = await import("../db/index"));
    jobsRepo = await import("./jobs");
    nextPostingId = 4_380_000_000;
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // A distinct, well-formed LinkedIn posting id per row unless the test names
  // its own URL: `extractExternalId` needs 6+ trailing digits, so deriving the
  // URL from a non-numeric test id would make every row unqualifiable and pass
  // the exclusion assertions for the wrong reason.
  let nextPostingId = 4_380_000_000;

  const insert = (
    id: string,
    overrides: {
      status?: JobStatus;
      jobUrl?: string;
      sourceJobId?: string | null;
      liveClosed?: boolean | null;
      liveStatusCheckedAt?: string | null;
      discoveredAt?: string;
    } = {},
  ) =>
    db.insert(schema.jobs).values({
      id,
      source: "linkedin",
      title: `Job ${id}`,
      employer: "Acme",
      jobUrl:
        overrides.jobUrl ??
        `https://www.linkedin.com/jobs/view/${nextPostingId++}`,
      sourceJobId: overrides.sourceJobId ?? null,
      status: overrides.status ?? "discovered",
      liveClosed: overrides.liveClosed ?? null,
      liveStatusCheckedAt: overrides.liveStatusCheckedAt ?? null,
      discoveredAt: overrides.discoveredAt ?? "2026-01-01T00:00:00.000Z",
    });

  // 0 = no floor: the cases outside the freshness describe block are about
  // ordering, eligibility and the cap, and a floor would confound them.
  const idsFor = async (limit: number) =>
    (await jobsRepo.getJobsForLiveStatusRefresh(limit, 0)).map((row) => row.id);

  it("puts never-checked rows first, newest discovery first among them", async () => {
    await insert("1", {
      liveStatusCheckedAt: "2026-02-01T00:00:00.000Z",
      discoveredAt: "2026-01-09T00:00:00.000Z",
    });
    await insert("2", {
      liveStatusCheckedAt: "2026-01-01T00:00:00.000Z",
      discoveredAt: "2026-01-08T00:00:00.000Z",
    });
    await insert("3", { discoveredAt: "2026-01-05T00:00:00.000Z" });
    await insert("4", { discoveredAt: "2026-01-07T00:00:00.000Z" });

    // Never-checked (4 then 3, newest discovery first), then by staleness
    // (2 checked in January before 1 checked in February).
    expect(await idsFor(10)).toEqual(["4", "3", "2", "1"]);
  });

  it("includes rows never checked and rows checked open, excludes closed ones", async () => {
    await insert("never", { liveClosed: null });
    await insert("open", {
      liveClosed: false,
      liveStatusCheckedAt: "2026-01-01T00:00:00.000Z",
    });
    await insert("closed", {
      liveClosed: true,
      liveStatusCheckedAt: "2026-01-01T00:00:00.000Z",
    });

    const ids = await idsFor(10);
    // The NULL row is the one a `live_closed != 1` predicate would silently
    // drop — SQLite's three-valued logic makes that comparison NULL, i.e.
    // false — and it is precisely the row this query exists to return.
    expect(ids).toContain("never");
    expect(ids).toContain("open");
    expect(ids).not.toContain("closed");
  });

  it("covers only the statuses a live verdict still changes something for", async () => {
    const included: JobStatus[] = [
      "discovered",
      "selected",
      "backlog",
      "ready",
    ];
    const excluded: JobStatus[] = [
      "processing",
      "applied",
      "in_progress",
      "stale",
      "skipped",
      "closed",
    ];
    for (const status of [...included, ...excluded]) {
      await insert(status, { status });
    }

    const ids = await idsFor(50);
    expect(ids.sort()).toEqual([...included].sort());
  });

  it("keeps only rows carrying a LinkedIn posting id", async () => {
    await insert("bare", {
      jobUrl: "https://www.linkedin.com/jobs/view/4383993915",
    });
    await insert("slug", {
      jobUrl:
        "https://uk.linkedin.com/jobs/view/senior-engineer-at-acme-4383993916",
    });
    await insert("from-source-id", {
      jobUrl: "https://www.linkedin.com/jobs/view/senior-engineer-at-acme",
      sourceJobId: "li-4383993917",
    });
    await insert("other-board", {
      jobUrl: "https://boards.greenhouse.io/acme/jobs/4383993918",
    });
    await insert("linkedin-not-a-job", {
      jobUrl: "https://www.linkedin.com/in/someone-4383993919",
    });

    const ids = await idsFor(50);
    expect(ids.sort()).toEqual(["bare", "from-source-id", "slug"]);
  });

  it("spends the cap on rows it can actually check", async () => {
    // These sort FIRST (never checked) and can never be checked, so a SQL
    // LIMIT applied before the id filter would hand back nothing — every run,
    // for ever, since a row that is never checked never gets a timestamp.
    for (const id of ["junk1", "junk2", "junk3"]) {
      await insert(id, {
        jobUrl: `https://www.linkedin.com/company/acme/${id}`,
        discoveredAt: "2026-02-01T00:00:00.000Z",
      });
    }
    await insert("real1", { discoveredAt: "2026-01-02T00:00:00.000Z" });
    await insert("real2", { discoveredAt: "2026-01-01T00:00:00.000Z" });

    expect(await idsFor(2)).toEqual(["real1", "real2"]);
  });

  describe("the freshness floor", () => {
    const hoursAgo = (h: number) =>
      new Date(Date.now() - h * 3_600_000).toISOString();

    it("skips rows checked inside the window and keeps ones outside it", async () => {
      await insert("fresh", { liveStatusCheckedAt: hoursAgo(1) });
      await insert("stale", { liveStatusCheckedAt: hoursAgo(72) });
      await insert("never", { liveStatusCheckedAt: null });

      const ids = (await jobsRepo.getJobsForLiveStatusRefresh(50, 24)).map(
        (row) => row.id,
      );

      // A never-checked row is not "recently checked" — it always passes.
      expect(ids.sort()).toEqual(["never", "stale"]);
    });

    it("compares timestamps as DATES, not as text", async () => {
      // The regression that motivates `datetime()` on both sides. Our column
      // holds ISO (`…T19:00:00.000Z`) while `datetime('now', …)` yields
      // `… 19:00:00`; as text those only compare correctly while the DATE
      // parts differ, because 'T' (0x54) sorts above ' ' (0x20). So this row
      // is placed on the SAME calendar date as the cutoff and earlier in the
      // day: genuinely stale, but a text compare calls it fresh and drops it.
      // The floor is chosen from the clock so the cutoff always lands around
      // midday, two days back: a fixed 48 would put it at whatever time the
      // suite runs, and at 00:00:00 UTC the row (midnight of the same date)
      // stops being strictly older and the test fails for a second a day —
      // the B20 day-boundary flake again. Twelve hours of margin on each side
      // also keeps the row and the cutoff on one date, which is what makes
      // this discriminate against a text compare at all.
      const minAgeHours = 36 + new Date().getUTCHours();
      const cutoff = new Date(Date.now() - minAgeHours * 3_600_000);
      const midnightOfCutoffDate = `${cutoff.toISOString().slice(0, 10)}T00:00:00.000Z`;
      await insert("same-date-but-older", {
        liveStatusCheckedAt: midnightOfCutoffDate,
      });

      const ids = (
        await jobsRepo.getJobsForLiveStatusRefresh(50, minAgeHours)
      ).map((row) => row.id);

      expect(ids).toEqual(["same-date-but-older"]);
    });

    it("treats an unparseable timestamp as ancient rather than as fresh", async () => {
      // `datetime()` answers NULL for junk, and a NULL comparison would drop
      // the row for ever. Erring toward re-checking is the safe direction.
      await insert("junk-timestamp", { liveStatusCheckedAt: "not a date" });

      const ids = (await jobsRepo.getJobsForLiveStatusRefresh(50, 24)).map(
        (row) => row.id,
      );

      expect(ids).toEqual(["junk-timestamp"]);
    });

    it("applies no floor at zero", async () => {
      await insert("just-checked", { liveStatusCheckedAt: hoursAgo(0) });

      expect(await idsFor(50)).toEqual(["just-checked"]);
      expect(
        (await jobsRepo.getJobsForLiveStatusRefresh(50, 0)).map((r) => r.id),
      ).toEqual(["just-checked"]);
    });

    it("lets a later run carry on down the list instead of repeating it", async () => {
      // The property the floor exists for, and the one a chain depends on:
      // each leg stamps what it checked, so the next leg's candidate set is
      // what is left rather than the same rows again.
      await insert("a", { discoveredAt: "2026-01-03T00:00:00.000Z" });
      await insert("b", { discoveredAt: "2026-01-02T00:00:00.000Z" });
      await insert("c", { discoveredAt: "2026-01-01T00:00:00.000Z" });

      const first = (await jobsRepo.getJobsForLiveStatusRefresh(2, 24)).map(
        (row) => row.id,
      );
      expect(first).toEqual(["a", "b"]);

      for (const id of first) {
        await jobsRepo.updateJob(id, {
          liveClosed: false,
          liveApplicants: "12 applicants",
          liveStatusCheckedAt: new Date().toISOString(),
        });
      }

      const second = (await jobsRepo.getJobsForLiveStatusRefresh(2, 24)).map(
        (row) => row.id,
      );
      expect(second).toEqual(["c"]);
    });
  });

  it("returns the requested number at most, and nothing for a non-positive cap", async () => {
    await insert("a");
    await insert("b");

    expect(await idsFor(1)).toHaveLength(1);
    expect(await idsFor(0)).toEqual([]);
  });
});
