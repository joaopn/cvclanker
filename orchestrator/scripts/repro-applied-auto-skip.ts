/**
 * Reproduction (B84): auto-skip moves a job you applied for.
 *
 * Walks the reachable path: a job applied for and later closed is reopened
 * (back to `discovered`, applied mark kept) and has its score cleared, so the
 * next run's scoring step picks it up like a new Inbox job. The scorer answers
 * `bad_fit` through a local fake provider, and auto-skip is on at `bad_fit`.
 *
 * The reopen and clear-score writes are the exact `updateJob` calls the two
 * job actions make (`routes/jobs.ts`).
 *
 * Exits non-zero while the bug exists.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "b84-repro-"));
process.on("exit", () => {
  rmSync(dataDir, { recursive: true, force: true });
});

const provider = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({ category: "bad_fit", reason: "repro" }),
          },
        },
      ],
    }),
  );
});
await new Promise<void>((resolve) => {
  provider.listen(0, "127.0.0.1", resolve);
});
const { port } = provider.address() as AddressInfo;

// A crash is a broken reproducer, not the bug: keep it off the bug's exit code.
// (A rejected top-level await exits 1, the same code the bug uses.)
try {
  process.env.DATA_DIR = dataDir;
  process.env.LLM_PROVIDER = "openai_compatible";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.LLM_API_KEY = "repro";

  await import("../src/server/db/migrate");
  const jobsRepo = await import("../src/server/repositories/jobs");
  const { db, schema } = await import("../src/server/db/index");
  const { scoreJobsStep } = await import(
    "../src/server/pipeline/steps/score-jobs"
  );

  const JOB_ID = "b84-repro-job";
  await db.insert(schema.jobs).values({
    id: JOB_ID,
    source: "manual",
    title: "Repro Engineer",
    employer: "Repro Ltd",
    jobUrl: "https://example.com/b84",
    jobDescription: "A role description long enough to be scoreable. ".repeat(
      5,
    ),
    status: "closed",
    outcome: "rejected",
    appliedAt: "2026-09-01T10:00:00.000Z",
    suitabilityCategory: "good_fit",
    suitabilityReason: "earlier score",
  });

  // Control: a never-applied job in the same run, which auto-skip must still
  // move. Without it a change that stopped auto-skip altogether would pass.
  const CONTROL_ID = "b84-control-job";
  await db.insert(schema.jobs).values({
    id: CONTROL_ID,
    source: "manual",
    title: "Control Engineer",
    employer: "Control Ltd",
    jobUrl: "https://example.com/b84-control",
    jobDescription: "A role description long enough to be scoreable. ".repeat(
      5,
    ),
    status: "discovered",
  });

  // Reopen, then Clear score.
  await jobsRepo.updateJob(JOB_ID, {
    status: "discovered",
    outcome: null,
    closedAt: null,
  });
  await jobsRepo.updateJob(JOB_ID, {
    suitabilityCategory: null,
    suitabilityReason: null,
    suitabilityModel: null,
    suitabilityEffort: null,
  });

  await scoreJobsStep({ brief: "", autoSkipCategory: "bad_fit" });
  provider.close();

  const after = await jobsRepo.getJobById(JOB_ID);
  if (after?.suitabilityCategory !== "bad_fit") {
    console.error(
      `✗ setup failed: the job was not scored (category ${JSON.stringify(after?.suitabilityCategory)})`,
    );
    process.exit(2);
  }
  const control = await jobsRepo.getJobById(CONTROL_ID);
  if (control?.status !== "skipped") {
    console.error(
      `✗ setup failed: auto-skip did not move the never-applied control job (status ${JSON.stringify(control?.status)})`,
    );
    process.exit(2);
  }
  if (after.status === "skipped") {
    console.error(
      "✗ B84: a job carrying the applied mark was auto-skipped out of the Inbox.",
    );
    process.exit(1);
  }
  console.log(
    `✓ scored bad_fit and left at "${after.status}" — the applied mark protects it.`,
  );
  process.exit(0);
} catch (error) {
  console.error("✗ reproducer crashed:", error);
  process.exit(2);
}
