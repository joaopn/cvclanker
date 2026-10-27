// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// B87: the jobs rebuild copies the whole table, so it must run only when the
// stored shape differs from the canonical one. A rebuild drops `jobs` and
// with it every index on it, so a hand-made index is the witness.
describe.sequential("jobs-table rebuild guard", () => {
  let tempDir: string;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
  }

  function openDb() {
    return new Database(join(tempDir, "jobs.db"));
  }

  function hasIndex(db: Database.Database, name: string) {
    return (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
        .get(name) !== undefined
    );
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jobs-rebuild-guard-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("skips the rebuild when the table is already canonical", async () => {
    await boot();
    const db = openDb();
    db.exec("CREATE INDEX witness_idx ON jobs(title)");
    db.exec("CREATE TABLE jobs_new (id TEXT)");
    db.close();

    await boot();

    const reopened = openDb();
    try {
      expect(hasIndex(reopened, "witness_idx")).toBe(true);
      const leftover = reopened
        .prepare("SELECT 1 FROM sqlite_master WHERE name='jobs_new'")
        .get();
      expect(leftover).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("rebuilds a table whose shape differs, keeping its rows", async () => {
    await boot();
    const db = openDb();
    db.exec("ALTER TABLE jobs ADD COLUMN legacy_extra TEXT");
    db.exec("CREATE INDEX witness_idx ON jobs(title)");
    db.prepare(
      `INSERT INTO jobs (id, source, title, employer, job_url, status)
       VALUES ('job-1', 'manual', 'Kept', 'Kept Ltd', 'https://example.com/b87', 'ready')`,
    ).run();
    db.close();

    await boot();

    const reopened = openDb();
    try {
      expect(hasIndex(reopened, "witness_idx")).toBe(false);
      const columns = reopened
        .prepare("PRAGMA table_info(jobs)")
        .all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).not.toContain("legacy_extra");
      const row = reopened
        .prepare("SELECT title, status FROM jobs WHERE id = 'job-1'")
        .get();
      expect(row).toEqual({ title: "Kept", status: "ready" });
    } finally {
      reopened.close();
    }
  });
});
