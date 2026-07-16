// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_SETTING_KEYS } from "@shared/settings-registry";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  applyRestore,
  exportSnapshot,
  validateSnapshot,
} from "./snapshot";

const SECRET_KEY = SECRET_SETTING_KEYS[0];

let workDir: string;

function makeSourceDb(path: string): void {
  const d = new Database(path);
  d.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE jobs (id TEXT PRIMARY KEY);
    CREATE TABLE cv_documents (id TEXT PRIMARY KEY);
    CREATE TABLE cover_letter_documents (id TEXT PRIMARY KEY);
    CREATE TABLE source_configs (extractor_id TEXT PRIMARY KEY);
    CREATE TABLE provider_instances (id TEXT PRIMARY KEY);
  `);
  d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    SECRET_KEY,
    "sk-super-secret",
  );
  d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
    "searchCountry",
    "Austria",
  );
  d.prepare("INSERT INTO jobs (id) VALUES (?)").run("job-1");
  d.close();
}

function readSetting(path: string, key: string): string | undefined {
  const d = new Database(path, { readonly: true });
  try {
    const row = d.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  } finally {
    d.close();
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "snapshot-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("exportSnapshot", () => {
  it("strips secret settings when includeSecrets is false, keeps data", () => {
    const source = join(workDir, "source.db");
    makeSourceDb(source);

    const result = exportSnapshot({ includeSecrets: false, sourcePath: source });
    try {
      expect(readSetting(result.path, SECRET_KEY)).toBeUndefined();
      expect(readSetting(result.path, "searchCountry")).toBe("Austria");
      // Row data is carried through.
      const d = new Database(result.path, { readonly: true });
      expect(d.prepare("SELECT COUNT(*) c FROM jobs").get()).toEqual({ c: 1 });
      d.close();
    } finally {
      result.cleanup();
    }
  });

  it("retains secret settings when includeSecrets is true", () => {
    const source = join(workDir, "source.db");
    makeSourceDb(source);

    const result = exportSnapshot({ includeSecrets: true, sourcePath: source });
    try {
      expect(readSetting(result.path, SECRET_KEY)).toBe("sk-super-secret");
    } finally {
      result.cleanup();
    }
  });

  it("stamps the backup format version", () => {
    const source = join(workDir, "source.db");
    makeSourceDb(source);

    const result = exportSnapshot({ includeSecrets: false, sourcePath: source });
    try {
      expect(readSetting(result.path, "__backup_format_version")).toBe(
        String(BACKUP_FORMAT_VERSION),
      );
    } finally {
      result.cleanup();
    }
  });
});

describe("validateSnapshot", () => {
  it("accepts a freshly exported snapshot", () => {
    const source = join(workDir, "source.db");
    makeSourceDb(source);
    const result = exportSnapshot({ includeSecrets: true, sourcePath: source });
    try {
      const verdict = validateSnapshot(result.path);
      expect(verdict.ok).toBe(true);
    } finally {
      result.cleanup();
    }
  });

  it("rejects a non-SQLite file", () => {
    const garbage = join(workDir, "garbage.db");
    writeFileSync(garbage, "this is not a database");
    const verdict = validateSnapshot(garbage);
    expect(verdict.ok).toBe(false);
  });

  it("rejects a valid SQLite db missing CV Clanker tables", () => {
    const stranger = join(workDir, "stranger.db");
    const d = new Database(stranger);
    d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    d.close();
    const verdict = validateSnapshot(stranger);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/missing tables/i);
  });

  it("rejects a snapshot stamped newer than this binary", () => {
    const source = join(workDir, "source.db");
    makeSourceDb(source);
    const result = exportSnapshot({ includeSecrets: true, sourcePath: source });
    try {
      const d = new Database(result.path);
      d.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
        String(BACKUP_FORMAT_VERSION + 1),
        "__backup_format_version",
      );
      d.close();
      const verdict = validateSnapshot(result.path);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/newer/i);
    } finally {
      result.cleanup();
    }
  });
});

describe("applyRestore", () => {
  it("swaps staging in and backs up the outgoing db", () => {
    const target = join(workDir, "jobs.db");
    const staging = join(workDir, "restore-staging.db");
    writeFileSync(target, "OLD");
    writeFileSync(staging, "NEW");
    // Stale sidecars should be cleared.
    writeFileSync(`${target}-wal`, "wal");
    writeFileSync(`${target}-shm`, "shm");

    applyRestore(staging, target);

    expect(readFileSync(target, "utf8")).toBe("NEW");
    expect(readFileSync(`${target}.bak`, "utf8")).toBe("OLD");
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(existsSync(`${target}-shm`)).toBe(false);
  });
});
