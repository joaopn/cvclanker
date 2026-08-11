// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProfileDatabases, repairDatabase } from "./clear-keyword-scores";

const KEYWORD_REASON = "Scored using keyword matching (API key not configured)";

let dir: string;
let dbPath: string;

function seed(rows: Array<Record<string, unknown>>): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    employer TEXT NOT NULL,
    status TEXT NOT NULL,
    suitability_category TEXT,
    suitability_reason TEXT,
    updated_at TEXT
  )`);
  const insert = db.prepare(
    "INSERT INTO jobs (id, title, employer, status, suitability_category, suitability_reason, updated_at) VALUES (@id, @title, @employer, @status, @suitability_category, @suitability_reason, @updated_at)",
  );
  for (const row of rows) {
    insert.run({
      title: "Engineer",
      employer: "Acme",
      status: "discovered",
      suitability_category: null,
      suitability_reason: null,
      updated_at: "2026-01-01T00:00:00.000Z",
      ...row,
    });
  }
  db.close();
}

function readAll(): AffectedShape[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      "SELECT id, status, suitability_category, suitability_reason FROM jobs ORDER BY id",
    )
    .all() as AffectedShape[];
  db.close();
  return rows;
}

interface AffectedShape {
  id: string;
  status: string;
  suitability_category: string | null;
  suitability_reason: string | null;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clear-keyword-"));
  dbPath = join(dir, "jobs.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("clear-keyword-scores", () => {
  it("clears the fabricated score and un-skips what it auto-skipped", () => {
    seed([
      {
        id: "kw-open",
        status: "discovered",
        suitability_category: "good_fit",
        suitability_reason: KEYWORD_REASON,
      },
      {
        id: "kw-skipped",
        status: "skipped",
        suitability_category: "bad_fit",
        suitability_reason: `${KEYWORD_REASON} Demoted one tier due to missing salary information.`,
      },
    ]);

    const result = repairDatabase(dbPath, { dryRun: false });

    expect(result).toMatchObject({ matched: 2, unskipped: 1 });
    const rows = readAll();
    for (const row of rows) {
      expect(row.suitability_category).toBeNull();
      expect(row.suitability_reason).toBeNull();
    }
    // The auto-skipped row has to come back, or the next run's scoring step —
    // which only reads `discovered` — can never reach it again.
    expect(rows.find((r) => r.id === "kw-skipped")?.status).toBe("discovered");
  });

  it("leaves a genuine LLM score alone, even one that says 'keyword'", () => {
    // Observed in the real database: real assessments discussing a job's
    // keywords. A looser LIKE would wipe them.
    seed([
      {
        id: "real",
        status: "discovered",
        suitability_category: "very_good_fit",
        suitability_reason:
          "Strong overlap on the keyword-heavy parts of the description.",
      },
    ]);

    const result = repairDatabase(dbPath, { dryRun: false });

    expect(result.matched).toBe(0);
    expect(readAll()[0]?.suitability_category).toBe("very_good_fit");
  });

  it("writes nothing on a dry run", () => {
    seed([
      {
        id: "kw",
        status: "skipped",
        suitability_category: "bad_fit",
        suitability_reason: KEYWORD_REASON,
      },
    ]);

    const result = repairDatabase(dbPath, { dryRun: true });

    expect(result).toMatchObject({ matched: 1, unskipped: 1 });
    expect(readAll()[0]).toMatchObject({
      status: "skipped",
      suitability_category: "bad_fit",
    });
  });

  it("is idempotent", () => {
    seed([
      {
        id: "kw",
        status: "discovered",
        suitability_category: "good_fit",
        suitability_reason: KEYWORD_REASON,
      },
    ]);

    expect(repairDatabase(dbPath, { dryRun: false }).matched).toBe(1);
    expect(repairDatabase(dbPath, { dryRun: false }).matched).toBe(0);
  });

  it("reports a missing database instead of creating one", () => {
    // A bare better-sqlite3 open would CREATE the file, leaving an empty DB
    // behind and reporting success.
    const result = repairDatabase(join(dir, "nope.db"), { dryRun: false });

    expect(result.error).toBeTruthy();
    expect(result.matched).toBe(0);
  });

  it("sweeps inactive profiles as well as the active database", () => {
    const paths = findProfileDatabases("/data");
    expect(paths[0]).toBe("/data/jobs.db");
  });
});
