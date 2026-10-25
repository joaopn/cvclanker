// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("dead prompt cleanup", () => {
  let tempDir: string;

  async function boot() {
    vi.resetModules();
    await import("./migrate");
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-dead-prompt-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("drops the legacy cv-extract prompt row, and keeps live ones", async () => {
    await boot();
    const db = new Database(join(tempDir, "jobs.db"));
    const insert = db.prepare(
      "INSERT INTO prompts (name, content, default_content) VALUES (?, ?, ?)",
    );
    insert.run("cv-extract", "name: cv-extract", "name: cv-extract");
    insert.run("cv-adjust", "name: cv-adjust", "name: cv-adjust");
    db.close();

    await boot();

    const reopened = new Database(join(tempDir, "jobs.db"), {
      readonly: true,
    });
    const names = (
      reopened.prepare("SELECT name FROM prompts").all() as { name: string }[]
    ).map((row) => row.name);
    reopened.close();
    expect(names).toContain("cv-adjust");
    expect(names).not.toContain("cv-extract");
  });
});
