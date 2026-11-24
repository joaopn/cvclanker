// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("assistant chat tables", () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-chat-tables-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    vi.resetModules();
    await import("./migrate");
    db = new Database(join(tempDir, "jobs.db"));
  });

  afterEach(async () => {
    db.close();
    const { closeDb } = await import("./index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates both tables on a fresh database", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('chat_threads', 'chat_messages') ORDER BY name",
      )
      .all();

    expect(tables).toEqual([
      { name: "chat_messages" },
      { name: "chat_threads" },
    ]);
  });

  it("deletes a chat's messages with the chat", () => {
    db.prepare("INSERT INTO chat_threads (id) VALUES ('t1'), ('t2')").run();
    db.prepare(
      `INSERT INTO chat_messages (id, thread_id, role, content, status)
       VALUES ('m1', 't1', 'user', 'a', 'complete'),
              ('m2', 't2', 'user', 'b', 'complete')`,
    ).run();

    db.prepare("DELETE FROM chat_threads WHERE id = 't1'").run();

    expect(db.prepare("SELECT id FROM chat_messages").all()).toEqual([
      { id: "m2" },
    ]);
  });
});
