// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The pre-widening shape exactly as migrate.ts shipped it (old CHECK,
// updated_at default, composite PK) so the rebuild's INSERT column list is
// exercised against the true legacy shape.
const LEGACY_JOB_PDFS_DDL = `CREATE TABLE job_pdfs (
   job_id TEXT NOT NULL,
   kind TEXT NOT NULL CHECK (kind IN ('resume','cover_letter')),
   data BLOB NOT NULL,
   updated_at TEXT NOT NULL DEFAULT (datetime('now')),
   PRIMARY KEY (job_id, kind)
 )`;

describe.sequential("job_pdfs kind-constraint rebuild", () => {
  let tempDir: string;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
  }

  function openDb() {
    return new Database(join(tempDir, "jobs.db"));
  }

  function insertPdf(db: Database.Database, jobId: string, kind: string) {
    db.prepare(
      "INSERT INTO job_pdfs (job_id, kind, data) VALUES (?, ?, ?)",
    ).run(jobId, kind, Buffer.from(`bytes-${kind}`));
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-job-pdfs-rebuild-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("widens a legacy CHECK and preserves rows", async () => {
    const legacy = openDb();
    legacy.exec(LEGACY_JOB_PDFS_DDL);
    insertPdf(legacy, "job-1", "resume");
    expect(() => insertPdf(legacy, "job-1", "resume_docx")).toThrow();
    legacy.close();

    await boot();

    const db = openDb();
    try {
      const master = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='job_pdfs'",
        )
        .get() as { sql: string };
      expect(master.sql).toContain("resume_docx");

      const row = db
        .prepare("SELECT data FROM job_pdfs WHERE job_id = ? AND kind = ?")
        .get("job-1", "resume") as { data: Buffer };
      expect(row.data.toString()).toBe("bytes-resume");

      insertPdf(db, "job-1", "resume_docx");
    } finally {
      db.close();
    }
  });

  it("fresh DBs accept resume_docx directly", async () => {
    await boot();

    const db = openDb();
    try {
      insertPdf(db, "job-2", "resume_docx");
    } finally {
      db.close();
    }
  });

  it("is idempotent across reboots", async () => {
    const legacy = openDb();
    legacy.exec(LEGACY_JOB_PDFS_DDL);
    insertPdf(legacy, "job-1", "resume");
    legacy.close();

    await boot();
    await boot();

    const db = openDb();
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'job_pdfs%'",
        )
        .all();
      expect(tables).toHaveLength(1);

      const count = db.prepare("SELECT COUNT(*) AS n FROM job_pdfs").get() as {
        n: number;
      };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
