// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DEAD_KEYS = [
  "chatStyleSummaryMaxWords",
  "chatStyleMaxKeywordsPerSkill",
  "missingSalaryPenalty",
];

describe.sequential("dead settings cleanup", () => {
  let tempDir: string;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-dead-settings-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("drops the rows of settings nothing reads, and keeps live ones", async () => {
    await boot();
    const db = new Database(join(tempDir, "jobs.db"));
    const insert = db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?)",
    );
    for (const key of DEAD_KEYS) insert.run(key, "5");
    insert.run("penalizeMissingSalary", "1");
    db.close();

    await boot();

    const reopened = new Database(join(tempDir, "jobs.db"), {
      readonly: true,
    });
    const keys = (
      reopened.prepare("SELECT key FROM settings").all() as { key: string }[]
    ).map((row) => row.key);
    reopened.close();
    expect(keys).toContain("penalizeMissingSalary");
    for (const key of DEAD_KEYS) expect(keys).not.toContain(key);
  });
});
