// @vitest-environment node
import type { UpdateJobInput } from "@shared/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.sequential("reconcileTransientStatuses", () => {
  let tempDir: string;
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jobs-reconcile-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    await import("../db/migrate");
    jobsRepo = await import("./jobs");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const seed = async (url: string, patch: UpdateJobInput): Promise<string> => {
    await jobsRepo.createJobs([
      {
        source: "linkedin",
        title: "T",
        employer: "E",
        jobUrl: url,
        datePosted: "2026-04-01",
      },
    ]);
    const job = await jobsRepo.getJobByUrl(url);
    if (!job) throw new Error(`seed failed for ${url}`);
    await jobsRepo.updateJob(job.id, patch);
    return job.id;
  };

  it("keeps processing jobs in Tailoring, stamping an interrupt reason only when none exists", async () => {
    const interrupted = await seed("https://ex/1", { status: "processing" });
    const alreadyFailed = await seed("https://ex/2", {
      status: "processing",
      tailoringFailureReason: "LLM provider timeout",
    });
    const selected = await seed("https://ex/3", { status: "selected" });

    await jobsRepo.reconcileTransientStatuses();

    const a = await jobsRepo.getJobById(interrupted);
    const b = await jobsRepo.getJobById(alreadyFailed);
    const c = await jobsRepo.getJobById(selected);

    // Interrupted mid-tailor → stays in Tailoring with an interrupt reason.
    expect(a?.status).toBe("processing");
    expect(a?.tailoringFailureReason).toMatch(/interrupted/i);
    // Already-failed → stays processing, its real reason preserved (not clobbered).
    expect(b?.status).toBe("processing");
    expect(b?.tailoringFailureReason).toBe("LLM provider timeout");
    // Legacy `selected` still drains to the inbox.
    expect(c?.status).toBe("discovered");
  });
});
