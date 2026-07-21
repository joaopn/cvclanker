// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("processJob failure keeps the row in Tailoring", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-tailor-fail-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("leaves a failed tailor at processing with a reason, not reverted to discovered", async () => {
    const jobsRepo = await import("../repositories/jobs");
    await jobsRepo.createJobs([
      {
        source: "linkedin",
        title: "T",
        employer: "E",
        jobUrl: "https://ex/fail",
        datePosted: "2026-04-01",
      },
    ]);
    const job = await jobsRepo.getJobByUrl("https://ex/fail");
    if (!job) throw new Error("seed failed");
    // Mirror the manual/background path, which pre-sets processing at the route.
    await jobsRepo.updateJob(job.id, { status: "processing" });

    // No active CV → summarizeJob fails fast (no network) → processJob fails.
    const { processJob } = await import("./orchestrator");
    const result = await processJob(job.id);

    expect(result.success).toBe(false);
    const after = await jobsRepo.getJobById(job.id);
    expect(after?.status).toBe("processing"); // NOT reverted to discovered
    expect(after?.tailoringFailureReason ?? "").not.toBe("");
  });
});
