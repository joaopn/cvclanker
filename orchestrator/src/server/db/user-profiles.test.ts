// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateStoredProfile,
  createFreshLiveDb,
  deleteStoredProfile,
  importStagingPath,
  listStoredProfiles,
  liveDbPath,
  readProfileName,
  readProfileStats,
  stashLiveDb,
  storeImportedProfile,
  storedProfilePath,
  userProfilesDir,
  writeProfileName,
} from "./user-profiles";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let workDir: string;
let originalDataDir: string | undefined;

function makeProfileDb(
  path: string,
  opts: {
    name?: string;
    jobIds?: string[];
    wal?: boolean;
    omitCvDocuments?: boolean;
    omitProfiles?: boolean;
  } = {},
): void {
  const d = new Database(path);
  if (opts.wal) {
    d.pragma("journal_mode = WAL");
  }
  d.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'discovered',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE cover_letter_documents (id TEXT PRIMARY KEY);
    CREATE TABLE source_configs (extractor_id TEXT PRIMARY KEY);
    CREATE TABLE provider_instances (id TEXT PRIMARY KEY);
  `);
  if (!opts.omitCvDocuments) {
    d.exec("CREATE TABLE cv_documents (id TEXT PRIMARY KEY);");
  }
  if (!opts.omitProfiles) {
    d.exec(
      "CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));",
    );
  }
  if (opts.name) {
    d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "userProfileName",
      opts.name,
    );
  }
  for (const id of opts.jobIds ?? []) {
    d.prepare("INSERT INTO jobs (id) VALUES (?)").run(id);
  }
  d.close();
}

function jobIds(path: string): string[] {
  const d = new Database(path, { readonly: true });
  try {
    const rows = d.prepare("SELECT id FROM jobs ORDER BY id").all() as {
      id: string;
    }[];
    return rows.map((r) => r.id);
  } finally {
    d.close();
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "user-profiles-test-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = workDir;
});

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("storedProfilePath", () => {
  it("rejects traversal attempts", () => {
    expect(() => storedProfilePath("../jobs")).toThrow(/Invalid user profile/);
    expect(() => storedProfilePath("..%2Fjobs")).toThrow(
      /Invalid user profile/,
    );
  });

  it("accepts uppercase UUIDs (zod .uuid() allows them)", () => {
    const upper = "6E42B5A0-1111-4222-8333-ABCDEF012345";
    expect(storedProfilePath(upper)).toBe(
      join(userProfilesDir(), `${upper}.db`),
    );
  });
});

describe("stashLiveDb", () => {
  it("moves the live DB into the store and clears sidecars", () => {
    makeProfileDb(liveDbPath(), { wal: true, jobIds: ["job-1", "job-2"] });
    writeFileSync(`${liveDbPath()}-shm`, "stale");

    const { id } = stashLiveDb();

    expect(id).toMatch(UUID_RE);
    expect(existsSync(liveDbPath())).toBe(false);
    expect(existsSync(`${liveDbPath()}-wal`)).toBe(false);
    expect(existsSync(`${liveDbPath()}-shm`)).toBe(false);
    expect(jobIds(storedProfilePath(id))).toEqual(["job-1", "job-2"]);
  });

  it("throws when the live DB is missing instead of fabricating one", () => {
    expect(() => stashLiveDb()).toThrow();
    expect(readdirSync(userProfilesDir())).toEqual([]);
  });
});

describe("activateStoredProfile", () => {
  it("swaps the stored profile in and stashes the outgoing live DB", () => {
    makeProfileDb(liveDbPath(), { name: "Old Live", jobIds: ["live-job"] });
    const storedId = "11111111-2222-4333-8444-555555555555";
    makeProfileDb(storedProfilePath(storedId), {
      name: "Stored",
      jobIds: ["stored-job"],
    });

    const { stashedId } = activateStoredProfile(storedId);

    expect(jobIds(liveDbPath())).toEqual(["stored-job"]);
    expect(readProfileName(liveDbPath())).toBe("Stored");
    expect(existsSync(storedProfilePath(storedId))).toBe(false);
    expect(jobIds(storedProfilePath(stashedId))).toEqual(["live-job"]);
    expect(readProfileName(storedProfilePath(stashedId))).toBe("Old Live");
  });

  it("throws without touching the live DB when the stored file is missing", () => {
    makeProfileDb(liveDbPath(), { jobIds: ["live-job"] });

    expect(() =>
      activateStoredProfile("99999999-9999-4999-8999-999999999999"),
    ).toThrow(/not found/);
    expect(jobIds(liveDbPath())).toEqual(["live-job"]);
  });
});

describe("storeImportedProfile", () => {
  it("keeps an existing self-describing name", () => {
    const staging = importStagingPath();
    makeProfileDb(staging, { name: "Brought Along" });

    const { id, name } = storeImportedProfile(staging);

    expect(name).toBe("Brought Along");
    expect(existsSync(staging)).toBe(false);
    expect(readProfileName(storedProfilePath(id))).toBe("Brought Along");
  });

  it("writes an Imported fallback name into nameless files", () => {
    const staging = importStagingPath();
    makeProfileDb(staging);

    const { id, name } = storeImportedProfile(staging);

    expect(name).toMatch(/^Imported \d{4}-\d{2}-\d{2}$/);
    expect(readProfileName(storedProfilePath(id))).toBe(name);
  });
});

describe("writeProfileName / readProfileName", () => {
  it("round-trips a rename in a closed file", () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    makeProfileDb(storedProfilePath(id), { name: "Before" });

    writeProfileName(storedProfilePath(id), "After");

    expect(readProfileName(storedProfilePath(id))).toBe("After");
  });

  it("returns null for unreadable files", () => {
    expect(readProfileName(join(workDir, "missing.db"))).toBeNull();
  });
});

describe("readProfileStats", () => {
  it("reads counts, search-profile names and last-updated", () => {
    const path = join(workDir, "full.db");
    makeProfileDb(path, { jobIds: ["a", "b"] });
    const d = new Database(path);
    d.prepare("UPDATE jobs SET status = 'applied' WHERE id = 'a'").run();
    d.prepare(
      "INSERT INTO profiles (id, name, updated_at) VALUES ('p1', 'Search One', '2026-01-02'), ('p2', 'Search Two', '2026-01-01')",
    ).run();
    d.prepare("INSERT INTO cv_documents (id) VALUES ('cv1')").run();
    d.close();

    const { stats, sizeBytes } = readProfileStats(path);

    expect(sizeBytes).toBeGreaterThan(0);
    expect(stats).not.toBeNull();
    expect(stats?.jobsTotal).toBe(2);
    expect(stats?.liveJobs).toBe(1);
    expect(stats?.cvDocuments).toBe(1);
    expect(stats?.searchProfileNames).toEqual(["Search One", "Search Two"]);
    expect(stats?.lastUpdatedAt).toBeTruthy();
  });

  it("degrades per-stat on older-shape DBs instead of failing", () => {
    const path = join(workDir, "older.db");
    makeProfileDb(path, {
      jobIds: ["a"],
      omitCvDocuments: true,
      omitProfiles: true,
    });

    const { stats } = readProfileStats(path);

    expect(stats?.jobsTotal).toBe(1);
    expect(stats?.cvDocuments).toBeNull();
    expect(stats?.searchProfileNames).toEqual([]);
  });
});

describe("listStoredProfiles", () => {
  it("lists valid profiles by name, flags invalid files, skips staging", () => {
    const validId = "12121212-3434-4565-8787-909090909090";
    makeProfileDb(storedProfilePath(validId), {
      name: "Good One",
      jobIds: ["j1"],
    });
    const invalidId = "21212121-4343-4656-8878-090909090909";
    writeFileSync(storedProfilePath(invalidId), "not sqlite at all");
    makeProfileDb(importStagingPath());

    const listed = listStoredProfiles();

    expect(listed).toHaveLength(2);
    const valid = listed.find((p) => p.id === validId);
    expect(valid?.name).toBe("Good One");
    expect(valid?.invalid).toBeUndefined();
    expect(valid?.stats?.jobsTotal).toBe(1);
    const invalid = listed.find((p) => p.id === invalidId);
    expect(invalid?.invalid).toBe(true);
    expect(invalid?.invalidReason).toBeTruthy();
    expect(invalid?.stats).toBeNull();
  });
});

describe("createFreshLiveDb", () => {
  it("creates a fresh live DB carrying the chosen name", () => {
    expect(existsSync(liveDbPath())).toBe(false);

    createFreshLiveDb("Job hunt 2027");

    expect(readProfileName(liveDbPath())).toBe("Job hunt 2027");
  });
});

describe("deleteStoredProfile", () => {
  it("removes the file and reports a repeat delete as missing", () => {
    const id = "fedcba98-7654-4321-8765-432109876543";
    makeProfileDb(storedProfilePath(id));

    expect(deleteStoredProfile(id)).toBe(true);
    expect(existsSync(storedProfilePath(id))).toBe(false);
    expect(deleteStoredProfile(id)).toBe(false);
  });
});
