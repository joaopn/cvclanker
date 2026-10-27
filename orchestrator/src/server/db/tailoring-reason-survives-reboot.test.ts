// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REASON = "LaTeX compile failed: Misplaced alignment tab character &.";

// B61: the jobs rebuild in migrate.ts must carry `tailoring_failure_reason`,
// or a rebuild wipes the real cause of a failed tailor. The rebuild runs only
// on a shape change, so the test makes one.
describe.sequential("tailoring failure reason across a reboot", () => {
  let tempDir: string;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-tailoring-reason-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("keeps the reason through the second boot's jobs rebuild", async () => {
    await boot();
    const db = new Database(join(tempDir, "jobs.db"));
    db.exec("ALTER TABLE jobs ADD COLUMN legacy_extra TEXT");
    db.prepare(
      `INSERT INTO jobs (id, source, title, employer, job_url, status, tailoring_failure_reason)
       VALUES ('job-1', 'manual', 'Repro', 'Repro Ltd', 'https://example.com/b61', 'processing', ?)`,
    ).run(REASON);
    db.close();

    await boot();

    const reopened = new Database(join(tempDir, "jobs.db"), {
      readonly: true,
    });
    const row = reopened
      .prepare(
        "SELECT tailoring_failure_reason AS reason FROM jobs WHERE id = 'job-1'",
      )
      .get() as { reason: string | null } | undefined;
    reopened.close();
    expect(row?.reason).toBe(REASON);
  });
});
