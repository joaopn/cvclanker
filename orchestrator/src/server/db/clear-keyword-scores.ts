/**
 * One-off repair for jobs that were "scored" by the removed keyword-matching
 * fallback.
 *
 * Before the rate-limit fix, any LLM failure — including a 429 session limit —
 * made the scorer fall back to a keyword heuristic and stamp the reason
 * "Scored using keyword matching (API key not configured)". Those rows carry a
 * fabricated suitability category that reads exactly like a real one. This
 * clears both scoring columns on them so they read as Unscored and get scored
 * properly on the next run (or via Recalculate match).
 *
 * Rows the fabricated score AUTO-SKIPPED are also returned to `discovered`:
 * the next run's scoring step only looks at discovered rows, so leaving them
 * skipped would mean the repair silently missed exactly the jobs the bad score
 * did the most damage to. A row skipped by hand that happens to carry a
 * keyword reason comes back too — indistinguishable from the outside, and
 * re-surfacing a job is the recoverable direction.
 *
 * Scans EVERY user profile: the active database plus every inactive one under
 * `DATA_DIR/user-profiles`. A profile you are not currently using is exactly
 * where a fabricated score would sit unnoticed.
 *
 * Idempotent: a second run finds nothing (cleared rows have a NULL reason).
 * Pass `--dry-run` to list what would change without writing.
 *
 * This module has NO side effects on import — `main()` is invoked only by
 * `clear-keyword-scores.cli.ts`. A module-scope `if (isMainThread) main()`
 * guard is NOT good enough: `isMainThread` is true inside a vitest fork too,
 * so importing this file from a test ran the destructive sweep against
 * whatever DATA_DIR resolved to.
 *
 * Usage:
 *   npm --workspace orchestrator run db:clear-keyword-scores -- --dry-run
 *   npm --workspace orchestrator run db:clear-keyword-scores
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getDataDir } from "../config/dataDir";

/**
 * The exact phrase the removed `mockScore` wrote. Kept as a literal rather than
 * imported, because the code that produced it is gone — this script has to
 * outlive it. Matched as a SUBSTRING because the salary penalty appended a
 * sentence after it.
 */
const KEYWORD_SCORE_MARKER =
  "Scored using keyword matching (API key not configured)";

export interface DatabaseRepairResult {
  path: string;
  matched: number;
  unskipped: number;
  error?: string;
}

interface AffectedRow {
  id: string;
  title: string;
  employer: string;
  status: string;
  suitability_category: string | null;
}

/**
 * Repair one database file. Opened directly rather than through the app's
 * connection so the inactive profiles can be swept too — and with
 * `fileMustExist` because a bare better-sqlite3 open CREATES a missing file.
 */
export function repairDatabase(
  path: string,
  options: { dryRun: boolean },
): DatabaseRepairResult {
  let db: Database.Database;
  try {
    db = new Database(path, { fileMustExist: true });
  } catch (error) {
    return { path, matched: 0, unskipped: 0, error: (error as Error).message };
  }

  try {
    const affected = db
      .prepare(
        "SELECT id, title, employer, status, suitability_category FROM jobs WHERE suitability_reason LIKE ?",
      )
      .all(`%${KEYWORD_SCORE_MARKER}%`) as AffectedRow[];

    for (const row of affected) {
      console.log(
        `  ${options.dryRun ? "would clear" : "clearing"} ${row.id} — ${row.title} @ ${row.employer} (${row.suitability_category}, status=${row.status})`,
      );
    }

    const skipped = affected.filter((row) => row.status === "skipped");
    if (options.dryRun || affected.length === 0) {
      return { path, matched: affected.length, unskipped: skipped.length };
    }

    const clear = db.prepare(
      "UPDATE jobs SET suitability_category = NULL, suitability_reason = NULL, updated_at = ? WHERE suitability_reason LIKE ?",
    );
    const unskip = db.prepare(
      "UPDATE jobs SET status = 'discovered', updated_at = ? WHERE id = ?",
    );
    const now = new Date().toISOString();

    db.transaction(() => {
      clear.run(now, `%${KEYWORD_SCORE_MARKER}%`);
      for (const row of skipped) unskip.run(now, row.id);
    })();

    return { path, matched: affected.length, unskipped: skipped.length };
  } finally {
    db.close();
  }
}

export function findProfileDatabases(dataDir: string): string[] {
  const paths = [join(dataDir, "jobs.db")];
  const profilesDir = join(dataDir, "user-profiles");
  try {
    for (const entry of readdirSync(profilesDir)) {
      if (entry.endsWith(".db")) paths.push(join(profilesDir, entry));
    }
  } catch {
    // No inactive profiles — the active database is the whole installation.
  }
  return paths;
}

export function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const databases = findProfileDatabases(getDataDir());

  let matched = 0;
  let unskipped = 0;
  for (const path of databases) {
    console.log(`${path}:`);
    const result = repairDatabase(path, { dryRun });
    if (result.error) {
      console.log(`  skipped — ${result.error}`);
      continue;
    }
    if (result.matched === 0) console.log("  nothing to do");
    matched += result.matched;
    unskipped += result.unskipped;
  }

  if (matched === 0) {
    console.log("\nNo keyword-matched scores found in any profile.");
    return;
  }

  const unskipNote =
    unskipped > 0
      ? ` ${unskipped} of them ${dryRun ? "would be" : "were"} returned to the Inbox from Skipped (auto-skipped on the fabricated score).`
      : "";
  console.log(
    dryRun
      ? `\n${matched} job(s) would be reset to unscored.${unskipNote}`
      : `\nReset ${matched} job(s) to unscored.${unskipNote} They will be scored on the next pipeline run, or immediately via Recalculate match.`,
  );
}
