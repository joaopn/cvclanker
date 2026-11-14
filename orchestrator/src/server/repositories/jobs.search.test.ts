// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobMatchesLock } from "@client/pages/orchestrator/JobCommandBar.utils";
import { STANDALONE_LETTER_FOLDS } from "@shared/location-support";
import { JOB_SEARCH_LOCKS, type JobStatus } from "@shared/types";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOBS_SEARCH_LETTER_FOLDS } from "../db/jobs-search-folds";

type SeedJob = {
  id: string;
  title?: string;
  employer?: string;
  location?: string | null;
  status?: JobStatus;
  appliedAt?: string | null;
  discoveredAt?: string;
};

describe.sequential("jobs repository search", () => {
  let tempDir: string;
  let jobsRepo: Awaited<typeof import("./jobs")>;

  async function boot() {
    vi.resetModules();
    await import("../db/migrate");
    jobsRepo = await import("./jobs");
  }

  async function closeRepoDb() {
    const { closeDb } = await import("../db/index");
    closeDb();
  }

  async function seed(rows: SeedJob[]) {
    const { db, schema } = await import("../db/index");
    for (const row of rows) {
      await db.insert(schema.jobs).values({
        id: row.id,
        source: "linkedin",
        title: row.title ?? "Untitled",
        employer: row.employer ?? "Nobody",
        location: row.location ?? null,
        jobUrl: `https://example.com/${row.id}`,
        status: row.status ?? "discovered",
        appliedAt: row.appliedAt ?? null,
        discoveredAt: row.discoveredAt ?? "2026-01-01T00:00:00.000Z",
      });
    }
  }

  async function ids(
    query: string,
    lock: (typeof JOB_SEARCH_LOCKS)[number] | null = null,
  ) {
    const result = await jobsRepo.searchJobListItems({ query, lock });
    return result.jobs.map((job) => job.id);
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jobs-search-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await boot();
  });

  afterEach(async () => {
    await closeRepoDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("matching", () => {
    beforeEach(async () => {
      await seed([
        { id: "title", title: "Senior Software Engineer", employer: "Acme" },
        { id: "split", title: "Senior Role", employer: "Engineering Ltd" },
        {
          id: "place",
          title: "Analyst",
          employer: "Beta",
          location: "Vienna, Austria",
        },
        { id: "dotted", title: "Node.js Developer", employer: "Gamma" },
      ]);
    });

    it("matches a word start in the title, the employer or the location", async () => {
      expect(await ids("softw")).toEqual(["title"]);
      expect(await ids("acme")).toEqual(["title"]);
      expect(await ids("vienna")).toEqual(["place"]);
    });

    it("needs the words together, in order, in one column", async () => {
      expect(await ids("software eng")).toEqual(["title"]);
      expect(await ids("engineer software")).toEqual([]);
      // "Senior" is in split's title and "Engineering" in its employer.
      expect(await ids("senior engineering")).toEqual([]);
    });

    it("does not match inside a word", async () => {
      expect(await ids("gineer")).toEqual([]);
    });

    it("splits on punctuation the same way on both sides", async () => {
      expect(await ids("node.js")).toEqual(["dotted"]);
      expect(await ids("node js")).toEqual(["dotted"]);
    });

    it("answers nothing, rather than everything, for input with no letter or digit", async () => {
      expect(
        await jobsRepo.searchJobListItems({ query: "++", lock: null }),
      ).toEqual({
        jobs: [],
        total: 0,
      });
    });

    it("drops a NUL rather than letting it cut the phrase short", async () => {
      expect(await ids("ac\u0000me")).toEqual(["title"]);
    });

    it("treats FTS syntax and quotes as text", async () => {
      expect(await ids('acme" OR "beta')).toEqual([]);
      expect(await ids("title:acme")).toEqual([]);
      expect(await ids("NOT acme")).toEqual([]);
    });
  });

  describe("folding", () => {
    it("folds accents and the letters NFD cannot reach, in both directions", async () => {
      await seed([
        { id: "accented", title: "Analyst", location: "Málaga" },
        { id: "plain", title: "Analyst", location: "Malaga" },
        { id: "decomposed", title: "Analyst", location: "Málaga" },
        { id: "eszett", title: "Analyst", employer: "Straße GmbH" },
        { id: "doubled", title: "Analyst", employer: "Strasse GmbH" },
        { id: "slash", title: "Analyst", location: "København" },
      ]);

      const malaga = ["accented", "decomposed", "plain"];
      expect((await ids("malaga")).sort()).toEqual(malaga);
      expect((await ids("málaga")).sort()).toEqual(malaga);
      expect((await ids("málaga")).sort()).toEqual(malaga);
      expect((await ids("strasse")).sort()).toEqual(["doubled", "eszett"]);
      expect((await ids("straße")).sort()).toEqual(["doubled", "eszett"]);
      expect(await ids("kobenhavn")).toEqual(["slash"]);
    });

    it("folds the same letters as the query does", () => {
      expect(JOBS_SEARCH_LETTER_FOLDS).toEqual(STANDALONE_LETTER_FOLDS);
    });

    it("finds every folded letter typed either way", async () => {
      const letters = Object.entries(JOBS_SEARCH_LETTER_FOLDS);
      await seed(
        letters.map(([letter], index) => ({
          id: `letter-${index}`,
          title: `qq${letter}zz`,
        })),
      );
      for (const [index, [letter, folded]] of letters.entries()) {
        expect(await ids(`qq${folded}zz`), letter).toContain(`letter-${index}`);
        expect(await ids(`qq${letter}zz`), letter).toContain(`letter-${index}`);
      }
    });
  });

  describe("locks", () => {
    const fixture: SeedJob[] = [
      { id: "discovered", status: "discovered" },
      { id: "processing", status: "processing" },
      { id: "ready", status: "ready" },
      {
        id: "applied",
        status: "applied",
        appliedAt: "2026-02-01T00:00:00.000Z",
      },
      {
        id: "in-progress",
        status: "in_progress",
        appliedAt: "2026-02-01T00:00:00.000Z",
      },
      {
        id: "closed-applied",
        status: "closed",
        appliedAt: "2026-02-01T00:00:00.000Z",
      },
      {
        id: "skipped-applied",
        status: "skipped",
        appliedAt: "2026-02-01T00:00:00.000Z",
      },
      { id: "skipped", status: "skipped" },
      { id: "closed", status: "closed" },
      { id: "backlog", status: "backlog" },
      { id: "stale", status: "stale" },
    ].map((row) => ({ ...row, title: "Platform Engineer" }) as SeedJob);

    beforeEach(async () => {
      await seed(fixture);
    });

    it("narrows exactly as the dialog's own lock check does", async () => {
      const all = (await jobsRepo.searchJobListItems({ query: "", lock: null }))
        .jobs;
      expect(all).toHaveLength(fixture.length);
      for (const lock of JOB_SEARCH_LOCKS) {
        const expected = all
          .filter((job) => jobMatchesLock(job, lock))
          .map((job) => job.id)
          .sort();
        expect(expected.length, lock).toBeGreaterThan(0);
        expect((await ids("", lock)).sort(), lock).toEqual(expected);
        expect((await ids("platform", lock)).sort(), lock).toEqual(expected);
        const result = await jobsRepo.searchJobListItems({
          query: "platform",
          lock,
        });
        expect(result.total, lock).toBe(expected.length);
      }
    });
  });

  describe("the result limit", () => {
    it("keeps the newest matches, puts whole-word matches first, and counts them all", async () => {
      const limit = jobsRepo.JOB_SEARCH_RESULT_LIMIT;
      const day = (n: number) =>
        new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
      await seed([
        {
          id: "old-exact",
          title: "Analyst",
          employer: "SAP",
          discoveredAt: day(0),
        },
        ...Array.from({ length: limit + 5 }, (_, n) => ({
          id: `prefix-${n}`,
          title: "Sapient Consultant",
          discoveredAt: day(n + 1),
        })),
      ]);

      const result = await jobsRepo.searchJobListItems({
        query: "sap",
        lock: null,
      });

      expect(result.jobs).toHaveLength(limit);
      expect(result.total).toBe(limit + 6);
      expect(result.jobs[0]?.id).toBe("old-exact");
      expect(result.jobs[1]?.id).toBe(`prefix-${limit + 4}`);
      expect(result.jobs.map((job) => job.id)).not.toContain("prefix-0");
    });

    it("lists the newest jobs for an empty query", async () => {
      await seed([
        { id: "older", discoveredAt: "2026-01-01T00:00:00.000Z" },
        { id: "newer", discoveredAt: "2026-02-01T00:00:00.000Z" },
      ]);
      const result = await jobsRepo.searchJobListItems({
        query: "  ",
        lock: null,
      });
      expect(result.jobs.map((job) => job.id)).toEqual(["newer", "older"]);
      expect(result.total).toBe(2);
    });
  });

  describe("keeping the index in step", () => {
    it("follows inserts, edits of the searched columns, and deletes", async () => {
      await seed([{ id: "job", title: "Data Engineer", employer: "Acme" }]);
      expect(await ids("data eng")).toEqual(["job"]);

      const { db, schema } = await import("../db/index");
      const { eq } = await import("drizzle-orm");
      await db
        .update(schema.jobs)
        .set({ title: "Platform Engineer" })
        .where(eq(schema.jobs.id, "job"));
      expect(await ids("data eng")).toEqual([]);
      expect(await ids("platform eng")).toEqual(["job"]);

      await db
        .update(schema.jobs)
        .set({ status: "skipped" })
        .where(eq(schema.jobs.id, "job"));
      expect(await ids("platform eng")).toEqual(["job"]);

      await db.delete(schema.jobs).where(eq(schema.jobs.id, "job"));
      expect(await ids("platform eng")).toEqual([]);
      expect(await ids("acme")).toEqual([]);
    });

    it("re-keys the index when a boot rebuilds the jobs table", async () => {
      await seed([
        { id: "first", title: "Alpha Role" },
        { id: "second", title: "Beta Role" },
      ]);
      await closeRepoDb();
      const raw = new Database(join(tempDir, "jobs.db"));
      // Leaves a gap at rowid 1, so the rebuild's fresh numbering shifts
      // `second` onto a rowid the stale index would hand to the wrong job.
      raw.exec("DELETE FROM jobs WHERE id = 'first'");
      raw.exec(
        "INSERT INTO jobs_search(rowid, title, employer, location) VALUES (1, 'stale', '', '')",
      );
      raw.exec("ALTER TABLE jobs ADD COLUMN legacy_extra TEXT");
      raw.close();

      await boot();

      expect(await ids("beta")).toEqual(["second"]);
      expect(await ids("stale")).toEqual([]);
      await seed([{ id: "third", title: "Gamma Role" }]);
      expect(await ids("gamma")).toEqual(["third"]);
    });

    it("rebuilds the index on a boot that skips the jobs rebuild", async () => {
      await seed([{ id: "job", title: "Alpha Role" }]);
      await closeRepoDb();
      const raw = new Database(join(tempDir, "jobs.db"));
      raw.exec("CREATE INDEX witness_idx ON jobs(title)");
      raw.exec("DELETE FROM jobs_search");
      raw.close();

      await boot();

      const reopened = new Database(join(tempDir, "jobs.db"));
      try {
        const witness = reopened
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='index' AND name='witness_idx'",
          )
          .get();
        expect(witness).toBeDefined();
      } finally {
        reopened.close();
      }
      expect(await ids("alpha")).toEqual(["job"]);
    });
  });

  it("walks a date index to the limit instead of sorting every match", async () => {
    const prepare = vi.spyOn(Database.prototype, "prepare");
    await jobsRepo.searchJobListItems({ query: "", lock: null });
    for (const lock of JOB_SEARCH_LOCKS) {
      await jobsRepo.searchJobListItems({ query: "role", lock });
    }
    await jobsRepo.searchJobListItems({ query: "role", lock: null });
    const picks = prepare.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes("INDEXED BY") && sql.includes("LIMIT"));
    prepare.mockRestore();

    expect(picks.length).toBeGreaterThanOrEqual(JOB_SEARCH_LOCKS.length + 2);
    const raw = new Database(join(tempDir, "jobs.db"), { readonly: true });
    try {
      for (const pick of picks) {
        const params = Array.from(pick.matchAll(/\?/g), () => "skipped");
        const plan = (
          raw.prepare(`EXPLAIN QUERY PLAN ${pick}`).all(...params) as Array<{
            detail: string;
          }>
        )
          .map((row) => row.detail)
          .join("; ");
        expect(plan, pick).not.toContain("TEMP B-TREE");
      }
    } finally {
      raw.close();
    }
  });
});
