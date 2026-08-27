// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { startServer, stopServer } from "./test-utils";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeProfileDb(path: string, name?: string): void {
  const d = new Database(path);
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
    CREATE TABLE cv_documents (id TEXT PRIMARY KEY);
    CREATE TABLE cover_letter_documents (id TEXT PRIMARY KEY);
    CREATE TABLE source_configs (extractor_id TEXT PRIMARY KEY);
    CREATE TABLE provider_instances (id TEXT PRIMARY KEY);
  `);
  if (name) {
    d.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "userProfileName",
      name,
    );
  }
  d.prepare("INSERT INTO jobs (id) VALUES ('fixture-job')").run();
  d.close();
}

function readProfileNameRaw(path: string): string | null {
  const d = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = d
      .prepare("SELECT value FROM settings WHERE key = 'userProfileName'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    d.close();
  }
}

function storeDir(tempDir: string): string {
  const dir = join(tempDir, "user-profiles");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function uploadProfile(
  baseUrl: string,
  bytes: Buffer,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), "backup.db");
  return fetch(`${baseUrl}/api/user-profiles/import`, {
    method: "POST",
    body: form,
  });
}

describe.sequential("User profiles API routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;
  let exitSpy: MockInstance;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    await stopServer({ server, closeDb, tempDir });
  });

  it("lists the active profile with the seeded name and live stats", async () => {
    const res = await fetch(`${baseUrl}/api/user-profiles`);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.data.active.name).toBe("Default");
    expect(body.data.active.sizeBytes).toBeGreaterThan(0);
    expect(body.data.active.stats.jobsTotal).toBe(0);
    expect(body.data.active.stats.searchProfileNames).toContain("Default");
    expect(body.data.stored).toEqual([]);
  });

  it("serves the lightweight active-name endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/user-profiles/active`);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ name: "Default" });
  });

  it("imports an uploaded DB as a stored profile without touching the live DB", async () => {
    const fixture = join(tempDir, "fixture.db");
    makeProfileDb(fixture, "Fixture Profile");

    const res = await uploadProfile(baseUrl, readFileSync(fixture));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.data.id).toMatch(UUID_RE);
    expect(body.data.name).toBe("Fixture Profile");
    expect(body.data.stats.jobsTotal).toBe(1);
    expect(existsSync(join(storeDir(tempDir), `${body.data.id}.db`))).toBe(
      true,
    );

    const list = await (await fetch(`${baseUrl}/api/user-profiles`)).json();
    expect(list.data.active.name).toBe("Default");
    expect(list.data.stored).toHaveLength(1);
    expect(list.data.stored[0].name).toBe("Fixture Profile");
  });

  it("rejects an invalid upload and removes the staging file", async () => {
    const res = await uploadProfile(baseUrl, Buffer.from("not a database"));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.ok).toBe(false);
    expect(existsSync(join(storeDir(tempDir), "import-staging.db"))).toBe(
      false,
    );
  });

  it("exports the active profile as a named snapshot download", async () => {
    const res = await fetch(`${baseUrl}/api/user-profiles/export`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /cvclanker-default-\d{4}-\d{2}-\d{2}\.db/,
    );
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.toString("utf8", 0, 15)).toBe("SQLite format 3");
  });

  it("exports a stored profile and 404s an unknown id", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    makeProfileDb(join(storeDir(tempDir), `${id}.db`), "Stored Copy");

    const res = await fetch(`${baseUrl}/api/user-profiles/${id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /cvclanker-stored-copy-/,
    );
    await res.arrayBuffer();

    const missing = await fetch(
      `${baseUrl}/api/user-profiles/99999999-9999-4999-8999-999999999999/export`,
    );
    expect(missing.status).toBe(404);
  });

  it("refuses to activate while a pipeline run is in flight", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const storedPath = join(storeDir(tempDir), `${id}.db`);
    makeProfileDb(storedPath, "Waiting");
    const { getPipelineStatus } = await import("@server/pipeline/index");
    vi.mocked(getPipelineStatus).mockReturnValue({ isRunning: true });

    const res = await fetch(`${baseUrl}/api/user-profiles/${id}/activate`, {
      method: "POST",
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(existsSync(storedPath)).toBe(true);
    expect(existsSync(join(tempDir, "jobs.db"))).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("refuses to activate while a bulk job action is in flight", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef";
    const storedPath = join(storeDir(tempDir), `${id}.db`);
    makeProfileDb(storedPath, "Waiting");

    // A detached batch outlives the browser that started it, so the user is
    // not necessarily watching one when they switch — and a swap closes the
    // database and exits the process out from under its writes.
    const { startJobActionBatch, resetJobActionBatchesForTests } = await import(
      "@server/services/job-actions/batch-store"
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batch = startJobActionBatch({
      action: "rescore",
      jobIds: ["held"],
      concurrency: 1,
      runJob: async (jobId) => {
        await gate;
        return { jobId, ok: false, error: { code: "X", message: "x" } };
      },
    });

    try {
      const res = await fetch(`${baseUrl}/api/user-profiles/${id}/activate`, {
        method: "POST",
      });
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.ok).toBe(false);
      expect(existsSync(storedPath)).toBe(true);
      expect(existsSync(join(tempDir, "jobs.db"))).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      // A failed assertion must not strand a running batch in module state —
      // every later swap test in this file would 409 on it.
      release();
      await batch.done;
      resetJobActionBatchesForTests();
    }
  });

  it("refuses to activate while a URL import is in flight", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01";
    const storedPath = join(storeDir(tempDir), `${id}.db`);
    makeProfileDb(storedPath, "Waiting");

    const { startUrlImportBatch, resetUrlImportBatchForTests } = await import(
      "@server/services/url-import/batch-store"
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = startUrlImportBatch({
      urls: ["https://example.com/held"],
      concurrency: 1,
      importUrl: async (url) => {
        await gate;
        return { ok: false, status: "failed", url, code: "X", message: "x" };
      },
    });

    try {
      const res = await fetch(`${baseUrl}/api/user-profiles/${id}/activate`, {
        method: "POST",
      });
      expect(res.status).toBe(409);
      expect(existsSync(join(tempDir, "jobs.db"))).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      release();
      await started?.done;
      resetUrlImportBatchForTests();
    }
  });

  it("refuses a fresh profile while a URL import is in flight", async () => {
    const { startUrlImportBatch, resetUrlImportBatchForTests } = await import(
      "@server/services/url-import/batch-store"
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = startUrlImportBatch({
      urls: ["https://example.com/held"],
      concurrency: 1,
      importUrl: async (url) => {
        await gate;
        return { ok: false, status: "failed", url, code: "X", message: "x" };
      },
    });

    try {
      const res = await fetch(`${baseUrl}/api/user-profiles/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      expect(existsSync(join(tempDir, "jobs.db"))).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      release();
      await started?.done;
      resetUrlImportBatchForTests();
    }
  });

  it("validates activation input", async () => {
    const badId = await fetch(
      `${baseUrl}/api/user-profiles/not-a-uuid/activate`,
      { method: "POST" },
    );
    expect(badId.status).toBe(400);

    const unknown = await fetch(
      `${baseUrl}/api/user-profiles/99999999-9999-4999-8999-999999999999/activate`,
      { method: "POST" },
    );
    expect(unknown.status).toBe(404);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("activates a stored profile, stashes the live DB, and exits to restart", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    makeProfileDb(join(storeDir(tempDir), `${id}.db`), "Stored Fixture");

    const res = await fetch(`${baseUrl}/api/user-profiles/${id}/activate`, {
      method: "POST",
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.data.restartRequired).toBe(true);
    expect(body.data.stashedId).toMatch(UUID_RE);

    const livePath = join(tempDir, "jobs.db");
    expect(readProfileNameRaw(livePath)).toBe("Stored Fixture");
    expect(existsSync(join(storeDir(tempDir), `${id}.db`))).toBe(false);
    expect(
      readProfileNameRaw(
        join(storeDir(tempDir), `${body.data.stashedId}.db`),
      ),
    ).toBe("Default");

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
  });

  it("starts a fresh profile by stashing the live DB and exiting", async () => {
    const res = await fetch(`${baseUrl}/api/user-profiles/new`, {
      method: "POST",
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.data.restartRequired).toBe(true);
    expect(existsSync(join(tempDir, "jobs.db"))).toBe(false);
    const stored = readdirSync(storeDir(tempDir)).filter((f) =>
      f.endsWith(".db"),
    );
    expect(stored).toEqual([`${body.data.stashedId}.db`]);

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
  });

  it("pre-seeds the chosen name when starting a fresh named profile", async () => {
    const res = await fetch(`${baseUrl}/api/user-profiles/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Job hunt 2027" }),
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.data.restartRequired).toBe(true);
    expect(readProfileNameRaw(join(tempDir, "jobs.db"))).toBe(
      "Job hunt 2027",
    );

    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
  });

  it("rejects an empty new-profile name without touching anything", async () => {
    const res = await fetch(`${baseUrl}/api/user-profiles/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(res.status).toBe(400);
    expect(existsSync(join(tempDir, "jobs.db"))).toBe(true);
    const stored = readdirSync(storeDir(tempDir)).filter((f) =>
      f.endsWith(".db"),
    );
    expect(stored).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("renames the active profile", async () => {
    const res = await fetch(`${baseUrl}/api/user-profiles/active`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Search Year" }),
    });
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ name: "My Search Year" });

    const active = await (
      await fetch(`${baseUrl}/api/user-profiles/active`)
    ).json();
    expect(active.data.name).toBe("My Search Year");
  });

  it("renames and deletes stored profiles", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const storedPath = join(storeDir(tempDir), `${id}.db`);
    makeProfileDb(storedPath, "Before");

    const rename = await fetch(`${baseUrl}/api/user-profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "After" }),
    });
    expect((await rename.json()).data).toEqual({ id, name: "After" });
    expect(readProfileNameRaw(storedPath)).toBe("After");

    const del = await fetch(`${baseUrl}/api/user-profiles/${id}`, {
      method: "DELETE",
    });
    expect((await del.json()).ok).toBe(true);
    expect(existsSync(storedPath)).toBe(false);

    const again = await fetch(`${baseUrl}/api/user-profiles/${id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  it("rejects renaming a stored file that is not a CV Clanker database", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    writeFileSync(join(storeDir(tempDir), `${id}.db`), "garbage");

    const res = await fetch(`${baseUrl}/api/user-profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(res.status).toBe(422);
  });
});
