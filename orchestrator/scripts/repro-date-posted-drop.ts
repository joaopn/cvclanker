/**
 * Reproduction: a job whose `date_posted` cannot be parsed is DROPPED at
 * ingestion rather than stored with an unknown posting date. The row is
 * counted as `rejected`, logged, and never inserted — so a board that writes
 * a relative date ("Vor 3 Tagen") or any format the normalizer does not know
 * silently costs you the whole ad, not just its date.
 *
 * Nothing downstream requires the column: `date_posted` is nullable, 2.5% of
 * rows in a real database already hold NULL, `sweepStaleJobs` COALESCEs to
 * `discovered_at`, and the UI's date pill already renders the unknown case.
 *
 * Exits non-zero while the bug exists.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = await mkdtemp(join(tmpdir(), "cvclanker-repro-dateposted-"));
process.env.DATA_DIR = tempDir;
process.env.NODE_ENV = "test";

await import("../src/server/db/migrate");
const jobsRepo = await import("../src/server/repositories/jobs");

const GOOD = "https://example.com/jobs/good-date";
const BAD = "https://example.com/jobs/unparseable-date";

const result = await jobsRepo.createJobs([
  {
    source: "linkedin",
    title: "Machine Learning Engineer",
    employer: "Acme",
    jobUrl: GOOD,
    datePosted: "2026-08-01",
  },
  {
    source: "linkedin",
    title: "Data Engineer",
    employer: "Acme",
    jobUrl: BAD,
    // What a board actually serves when it renders a relative date.
    datePosted: "Vor 3 Tagen",
  },
]);

const stored = await jobsRepo.getJobByUrl(BAD);

const { closeDb } = await import("../src/server/db/index");
closeDb();
await rm(tempDir, { recursive: true, force: true });

if (!stored) {
  console.error(
    `FAIL: the ad with an unparseable date was dropped (created=${result.created}, rejected=${result.rejected}) — the whole job is lost, not just its posting date.`,
  );
  process.exit(1);
}

if (stored.datePosted !== null) {
  console.error(
    `FAIL: expected an unknown posting date, got ${JSON.stringify(stored.datePosted)}.`,
  );
  process.exit(1);
}

console.log(
  `PASS: the ad was imported with an unknown posting date (created=${result.created}, rejected=${result.rejected}).`,
);
