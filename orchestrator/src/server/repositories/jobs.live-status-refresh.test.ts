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

  const idsFor = async (limit: number) =>
    (await jobsRepo.getJobsForLiveStatusRefresh(limit)).map((row) => row.id);

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

  it("returns the requested number at most, and nothing for a non-positive cap", async () => {
    await insert("a");
    await insert("b");

    expect(await idsFor(1)).toHaveLength(1);
    expect(await idsFor(0)).toEqual([]);
  });
});
