// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getJobsRevision` runs on every jobs-list load and on the client's change
// poll. Without an index holding `updated_at` it reads every row in scope
// (every row when unscoped), and `updated_at` is the last column of the row,
// so any row too large for its page is read through its overflow chain.
describe.sequential("jobs revision index", () => {
  let tempDir: string;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
  }

  function openDb() {
    return new Database(join(tempDir, "jobs.db"));
  }

  // The plans of the SQL the repository really sends, captured at prepare
  // time, rather than of a hand-written copy that could drift from it.
  async function revisionQueryPlans(): Promise<string[]> {
    vi.resetModules();
    const prepare = vi.spyOn(Database.prototype, "prepare");
    const statements: string[] = [];
    try {
      const repo = await import("../repositories/jobs");
      await repo.getJobsRevision();
      await repo.getJobsRevision(["discovered", "ready"]);
      for (const [sql] of prepare.mock.calls) {
        if (sql.includes("max(")) statements.push(sql);
      }
    } finally {
      prepare.mockRestore();
      const { closeDb } = await import("./index");
      closeDb();
    }

    const db = openDb();
    try {
      return statements.map((sql) => {
        const params = Array.from(sql.matchAll(/\?/g), () => "discovered");
        const rows = db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params) as Array<{ detail: string }>;
        return rows.map((row) => row.detail).join("; ");
      });
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jobs-revision-index-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("answers both revision shapes from the covering index", async () => {
    await boot();

    const plans = await revisionQueryPlans();

    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan).toContain("COVERING INDEX idx_jobs_status_updated_at");
    }
  });

  // A fresh database always takes the rebuild on its first boot, so the test
  // above cannot tell "created after the rebuild" from "created by it". An
  // existing canonical database skips the rebuild, and that is the database
  // this index is for.
  it("adds the index to a canonical database that skips the rebuild", async () => {
    await boot();
    const db = openDb();
    db.exec("DROP INDEX idx_jobs_status_updated_at");
    db.exec("CREATE INDEX witness_idx ON jobs(title)");
    db.close();

    await boot();

    const reopened = openDb();
    try {
      const witness = reopened
        .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
        .get("witness_idx");
      expect(witness).toBeDefined();
    } finally {
      reopened.close();
    }
    const plans = await revisionQueryPlans();
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan).toContain("COVERING INDEX idx_jobs_status_updated_at");
    }
  });

  it("keeps the index when the jobs table is rebuilt", async () => {
    await boot();
    const db = openDb();
    db.exec("ALTER TABLE jobs ADD COLUMN legacy_extra TEXT");
    db.close();

    await boot();

    const reopened = openDb();
    try {
      const columns = reopened
        .prepare("PRAGMA table_info(jobs)")
        .all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).not.toContain("legacy_extra");
    } finally {
      reopened.close();
    }
    const plans = await revisionQueryPlans();
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan).toContain("COVERING INDEX idx_jobs_status_updated_at");
    }
  });
});
