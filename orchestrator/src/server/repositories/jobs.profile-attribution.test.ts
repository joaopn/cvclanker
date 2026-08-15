// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs the real migration against a throwaway DATA_DIR, so this also proves
// the new profile_id column actually survives migrate on a fresh DB.
describe.sequential("jobs repository profile attribution", () => {
  let tempDir: string;
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jobs-profile-"));
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

  const jobAt = (url: string, datePosted: string, profileId?: string) => ({
    source: "linkedin" as const,
    title: "Backend Engineer",
    employer: "Acme",
    jobUrl: url,
    datePosted,
    profileId,
  });

  it("stores the discovering profile on insert and leaves it null without one", async () => {
    await jobsRepo.createJobs([
      jobAt("https://example.com/jobs/attributed", "2026-04-01", "profile-a"),
      jobAt("https://example.com/jobs/anonymous", "2026-04-01"),
    ]);

    const attributed = await jobsRepo.getJobByUrl(
      "https://example.com/jobs/attributed",
    );
    const anonymous = await jobsRepo.getJobByUrl(
      "https://example.com/jobs/anonymous",
    );
    expect(attributed?.profileId).toBe("profile-a");
    expect(anonymous?.profileId).toBeNull();
  });

  it("keeps the first discoverer when a second profile re-imports the same URL", async () => {
    const url = "https://example.com/jobs/shared";
    await jobsRepo.createJobs([jobAt(url, "2026-04-01", "profile-a")]);

    const result = await jobsRepo.createJobs([
      jobAt(url, "2026-04-01", "profile-b"),
    ]);

    expect(result.skipped).toBe(1);
    expect((await jobsRepo.getJobByUrl(url))?.profileId).toBe("profile-a");
  });

  it("keeps the first discoverer through a repost", async () => {
    const url = "https://example.com/jobs/reposted";
    await jobsRepo.createJobs([jobAt(url, "2026-04-01", "profile-a")]);

    // A forward datePosted shift takes the repost branch, which updates the
    // row in place — attribution must not ride along with it.
    const result = await jobsRepo.createJobs([
      jobAt(url, "2026-05-01", "profile-b"),
    ]);

    expect(result.reposted).toBe(1);
    const job = await jobsRepo.getJobByUrl(url);
    expect(job?.repostCount).toBe(1);
    expect(job?.profileId).toBe("profile-a");
  });

  it("surfaces the attribution on list items, not just the full job", async () => {
    await jobsRepo.createJobs([
      jobAt("https://example.com/jobs/listed", "2026-04-01", "profile-a"),
    ]);

    const [item] = await jobsRepo.getJobListItems(["discovered"]);
    expect(item?.profileId).toBe("profile-a");
  });
});
