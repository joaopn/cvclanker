import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const REASON = "LaTeX compile failed: Misplaced alignment tab character &.";
const JOB_ID = "b61-repro-job";
const MIGRATE = join(import.meta.dirname, "../src/server/db/migrate.ts");

const dataDir = mkdtempSync(join(tmpdir(), "b61-repro-"));

// `process.exit` does NOT run `finally`, and there is no try/catch here, so an
// uncaught throw from `migrate()` or better-sqlite3 would leak the temp DB too.
// An exit hook covers every path: explicit exit, normal return, and throw.
process.on("exit", () => {
  rmSync(dataDir, { recursive: true, force: true });
});

function done(code: number): never {
  process.exit(code);
}

function migrate(): void {
  execFileSync("npx", ["tsx", MIGRATE], {
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: "ignore",
  });
}

// Boot 1: create the schema.
{
  migrate();

  const dbPath = join(dataDir, "jobs.db");
  const seed = new Database(dbPath, { fileMustExist: true });
  seed
    .prepare(
      `INSERT INTO jobs (id, source, title, employer, job_url, status, tailoring_failure_reason)
       VALUES (?, 'manual', 'Repro', 'Repro Ltd', 'https://example.com/b61', 'processing', ?)`,
    )
    .run(JOB_ID, REASON);
  const before = seed
    .prepare("SELECT tailoring_failure_reason AS reason FROM jobs WHERE id = ?")
    .get(JOB_ID) as { reason: string | null } | undefined;
  seed.close();

  if (before?.reason !== REASON) {
    console.error(
      `✗ setup failed: expected the seeded reason back, got ${JSON.stringify(before?.reason)}`,
    );
    done(1);
  }
  console.log(`before reboot: ${JSON.stringify(before.reason)}`);

  // Boot 2: the every-boot rebuild runs again over a table that now HAS the
  // column. This is the step that loses it.
  migrate();

  const after = new Database(dbPath, { readonly: true, fileMustExist: true });
  const row = after
    .prepare("SELECT tailoring_failure_reason AS reason FROM jobs WHERE id = ?")
    .get(JOB_ID) as { reason: string | null } | undefined;
  after.close();

  if (!row) {
    console.error("✗ the seeded job row did not survive the second migrate");
    done(1);
  }
  console.log(`after reboot:  ${JSON.stringify(row.reason)}`);

  if (row.reason === REASON) {
    console.log("✓ the tailoring failure reason survived a reboot");
    done(0);
  }

  console.error(
    "✗ B61: the every-boot jobs rebuild dropped tailoring_failure_reason — the real cause of a failed tailor is replaced by a restart notice",
  );
  done(1);
}
