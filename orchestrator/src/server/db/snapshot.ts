/**
 * DB portability — consistent snapshot export + restore validation.
 *
 * The DB is the installation: every CV / cover-letter archive AND every
 * generated job PDF lives as a BLOB inside `jobs.db` (`job_pdfs`), alongside
 * all jobs, settings, provider config, and the JWT signing secret
 * (`runtime_secrets`). A single consistent snapshot of `jobs.db` is therefore
 * a complete, portable backup. Secrets-stripped exports clear both the
 * credential settings AND `runtime_secrets` — restoring one regenerates the
 * signing secret at first login (sessions from before the export won't
 * carry over); with-secrets exports keep sessions working after restore.
 *
 * This module is deliberately import-free of `./index` (the DB singleton opens
 * SQLite at module load). The pure export/validate helpers open their own
 * connections against an explicit path so they can be unit-tested without
 * touching the live DB; the live-connection swap is the route's job
 * (`closeDb()` then `applyRestore`).
 */

import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_SETTING_KEYS } from "@shared/settings-registry";
import Database from "better-sqlite3";
import { getDataDir } from "../config/dataDir";

/**
 * Bump when a schema change makes older binaries unable to read a newer
 * snapshot. Restore refuses any snapshot stamped higher than this — we
 * forward-migrate older snapshots (migrations are idempotent on boot) but
 * never down-migrate.
 */
export const BACKUP_FORMAT_VERSION = 2;

const VERSION_SETTING_KEY = "__backup_format_version";

/** Tables a genuine CV Clanker snapshot must contain (guards against arbitrary
 * SQLite files being uploaded to the restore endpoint). */
const REQUIRED_TABLES = [
  "jobs",
  "settings",
  "cv_documents",
  "cover_letter_documents",
  "source_configs",
  "provider_instances",
];

function liveDbPath(): string {
  return join(getDataDir(), "jobs.db");
}

export interface ExportResult {
  /** Absolute path to the snapshot file, ready to stream. */
  path: string;
  /** Remove the temp dir holding the snapshot — call after the stream closes. */
  cleanup: () => void;
}

/**
 * Produce a consistent single-file snapshot of the live DB via `VACUUM INTO`
 * (safe under WAL + concurrent writes; a naive file copy can miss
 * un-checkpointed WAL frames). The snapshot is post-processed on a throwaway
 * connection: stamped with the format version and, unless `includeSecrets`,
 * stripped of credential settings. The live DB is never mutated.
 */
export function exportSnapshot(opts: {
  includeSecrets: boolean;
  sourcePath?: string;
}): ExportResult {
  const source = opts.sourcePath ?? liveDbPath();
  const dir = mkdtempSync(join(tmpdir(), "cvclanker-export-"));
  const out = join(dir, "snapshot.db");

  // VACUUM INTO reads the source and writes a compacted, consistent copy to
  // `out` (safe under WAL — sees committed state including un-checkpointed
  // frames — and never mutates the source).
  const reader = new Database(source, { fileMustExist: true });
  try {
    reader.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } finally {
    reader.close();
  }

  const copy = new Database(out);
  try {
    stampVersion(copy);
    if (!opts.includeSecrets) redactSecrets(copy);
  } finally {
    copy.close();
  }

  return {
    path: out,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function stampVersion(d: Database.Database): void {
  const now = new Date().toISOString();
  d.prepare(
    `INSERT INTO settings (key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(VERSION_SETTING_KEY, String(BACKUP_FORMAT_VERSION), now, now);
}

function redactSecrets(d: Database.Database): void {
  const stmt = d.prepare("DELETE FROM settings WHERE key = ?");
  for (const key of SECRET_SETTING_KEYS) stmt.run(key);

  // The JWT signing secret lives outside `settings`. Table-existence guard:
  // this also runs against test fixtures / older snapshots that predate
  // runtime_secrets.
  const hasRuntimeSecrets = d
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_secrets'",
    )
    .get();
  if (hasRuntimeSecrets) {
    d.prepare("DELETE FROM runtime_secrets").run();
  }

  // Per-provider API keys are secrets in a table of their own. The base URL is
  // configuration rather than a credential, so the row survives with its key
  // cleared — a restored snapshot keeps pointing at the right endpoint and asks
  // only for the key back.
  const hasProviderCredentials = d
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'llm_provider_credentials'",
    )
    .get();
  if (hasProviderCredentials) {
    d.prepare("UPDATE llm_provider_credentials SET api_key = NULL").run();
  }
}

export type ValidateResult =
  | { ok: true; formatVersion: number }
  | { ok: false; reason: string };

/**
 * Validate an uploaded file is a restorable CV Clanker snapshot: opens cleanly,
 * passes `integrity_check`, contains the core tables, and is not stamped
 * with a newer format version than this binary understands.
 */
export function validateSnapshot(path: string): ValidateResult {
  let d: Database.Database;
  try {
    d = new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    return {
      ok: false,
      reason: `Not a readable SQLite database: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  try {
    // A non-SQLite file often opens fine but throws on the first real query.
    const integrity = d.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      return { ok: false, reason: `Integrity check failed: ${integrity}` };
    }

    const tableRows = d
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    const present = new Set(tableRows.map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Not a CV Clanker backup — missing tables: ${missing.join(", ")}`,
      };
    }

    const versionRow = d
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(VERSION_SETTING_KEY) as { value: string } | undefined;
    const formatVersion = versionRow ? Number(versionRow.value) : 0;
    if (
      Number.isFinite(formatVersion) &&
      formatVersion > BACKUP_FORMAT_VERSION
    ) {
      return {
        ok: false,
        reason: `Backup format v${formatVersion} is newer than this app supports (v${BACKUP_FORMAT_VERSION}). Update the app, then restore.`,
      };
    }

    return { ok: true, formatVersion };
  } catch (error) {
    return {
      ok: false,
      reason: `Not a valid backup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    d.close();
  }
}

/**
 * Swap a validated snapshot in as the live DB. The caller MUST have closed the
 * live connection (`closeDb()`) first. Backs up the outgoing DB to
 * `jobs.db.bak`, clears stale WAL/SHM sidecars, and renames the snapshot into
 * place. The process must restart afterward to re-open the connection and run
 * idempotent migrations.
 */
export function applyRestore(
  stagingPath: string,
  targetPath = liveDbPath(),
): void {
  for (const sidecar of [`${targetPath}-wal`, `${targetPath}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
  if (existsSync(targetPath)) {
    renameSync(targetPath, `${targetPath}.bak`);
  }
  renameSync(stagingPath, targetPath);
}

/** Staging path for an uploaded restore file — kept on the same filesystem as
 * the live DB so the final rename is atomic. */
export function restoreStagingPath(): string {
  return join(getDataDir(), "restore-staging.db");
}
