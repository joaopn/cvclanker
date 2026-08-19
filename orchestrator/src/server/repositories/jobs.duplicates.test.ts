// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type JobStatusLiteral =
  | "discovered"
  | "selected"
  | "processing"
  | "ready"
  | "backlog"
  | "stale"
  | "skipped"
  | "closed";

describe.sequential("jobs repository duplicate groups", () => {
  let tempDir: string;
  let db: Awaited<typeof import("../db/index")>["db"];
  let schema: Awaited<typeof import("../db/index")>["schema"];
  let jobsRepo: Awaited<typeof import("./jobs")>;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), "cvclanker-jobs-dups-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";

    await import("../db/migrate");
    ({ db, schema } = await import("../db/index"));
    jobsRepo = await import("./jobs");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /** `jobUrl` is the identity now, so every case states it explicitly. */
  const insert = (args: {
    id: string;
    title: string;
    employer?: string;
    status: JobStatusLiteral;
    jobUrl: string;
    source?: string;
  }) =>
    db.insert(schema.jobs).values({
      id: args.id,
      source: args.source ?? "linkedin",
      title: args.title,
      employer: args.employer ?? "Acme Corp",
      jobUrl: args.jobUrl,
      status: args.status,
    });

  it("groups rows the board lists under one posting id, across subdomains and scrapers", async () => {
    // The case a URL comparison can never make: one LinkedIn posting arriving
    // under a country subdomain and a slug from one scraper, and bare from
    // another.
    await insert({
      id: "a1",
      title: "Senior Data Architect",
      status: "discovered",
      jobUrl: "https://www.linkedin.com/jobs/view/4383993915",
    });
    await insert({
      id: "a2",
      title: "Senior Data Architect",
      status: "selected",
      source: "apify:17217e9c",
      jobUrl:
        "https://at.linkedin.com/jobs/view/senior-data-architect-at-nagarro-4383993915",
    });

    const groups = await jobsRepo.getDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("linkedin:4383993915");
    expect(groups[0].jobs.map((j) => j.id).sort()).toEqual(["a1", "a2"]);
    expect(groups[0].bulkSafe).toBe(true);
  });

  it("does NOT group on title and company alone", async () => {
    // The whole reason for the change: eight Amazon rows sharing a title and
    // city were seven distinct requisitions. Same title, same employer,
    // different postings — and now, correctly, no group.
    await insert({
      id: "b1",
      title: "Software Development Engineer",
      employer: "Amazon",
      status: "discovered",
      jobUrl: "https://www.linkedin.com/jobs/view/4455739231",
    });
    await insert({
      id: "b2",
      title: "Software Development Engineer",
      employer: "Amazon",
      status: "discovered",
      jobUrl: "https://www.linkedin.com/jobs/view/4455982701",
    });

    expect(await jobsRepo.getDuplicateGroups()).toHaveLength(0);
  });

  it("does not propose rows with no parseable board id", async () => {
    // Missing evidence must never buy a match.
    await insert({
      id: "c1",
      title: "Data Engineer",
      status: "discovered",
      jobUrl: "https://jobs.smartrecruiters.com/Acme/744000114351267",
      source: "hiringcafe",
    });
    await insert({
      id: "c2",
      title: "Data Engineer",
      status: "discovered",
      // The SAME trailing id under the same unrecognised host: if this board
      // were ever added to `extractBoard` these two would group, so the
      // assertion can only be satisfied by "no board identity", which is what
      // it claims to pin.
      jobUrl: "https://jobs.smartrecruiters.com/Other/744000114351267",
      source: "hiringcafe",
    });

    expect(await jobsRepo.getDuplicateGroups()).toHaveLength(0);
  });

  it("marks a group whose rows disagree about the title as review-only", async () => {
    // A board id is strong evidence, not perfect: measured, 39 of 823 id
    // clusters carry more than one distinct title. Those stay reviewable but
    // must never be swept in bulk.
    await insert({
      id: "d1",
      title: "Senior Machine Learning Scientist - Marketplace",
      employer: "Booking.com",
      status: "discovered",
      jobUrl: "https://www.linkedin.com/jobs/view/4435122980",
    });
    await insert({
      id: "d2",
      title: "Machine Learning Science - IC - G - I",
      employer: "Booking.com",
      status: "discovered",
      source: "apify:17217e9c",
      jobUrl:
        "https://nl.linkedin.com/jobs/view/machine-learning-science-ic-g-i-at-booking-com-4435122980",
    });

    const groups = await jobsRepo.getDuplicateGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].bulkSafe).toBe(false);
  });

  it("excludes singletons and out-of-scope statuses", async () => {
    await insert({
      id: "e1",
      title: "Backend Engineer",
      status: "discovered",
      jobUrl: "https://www.linkedin.com/jobs/view/4400000001",
    });
    await insert({
      id: "e2",
      title: "Backend Engineer",
      status: "closed",
      jobUrl: "https://uk.linkedin.com/jobs/view/backend-engineer-4400000001",
    });
    await insert({
      id: "e3",
      title: "Platform Engineer",
      status: "selected",
      jobUrl: "https://www.linkedin.com/jobs/view/4400000002",
    });

    expect(await jobsRepo.getDuplicateGroups()).toHaveLength(0);
  });

  it("orders the largest clusters first", async () => {
    await insert({
      id: "f1",
      title: "QA Engineer",
      status: "discovered",
      jobUrl: "https://www.linkedin.com/jobs/view/4400000010",
    });
    await insert({
      id: "f2",
      title: "QA Engineer",
      status: "selected",
      jobUrl: "https://uk.linkedin.com/jobs/view/qa-engineer-4400000010",
    });
    await insert({
      id: "g1",
      title: "DevOps Engineer",
      status: "discovered",
      jobUrl: "https://www.linkedin.com/jobs/view/4400000020",
    });
    await insert({
      id: "g2",
      title: "DevOps Engineer",
      status: "ready",
      jobUrl: "https://ie.linkedin.com/jobs/view/devops-engineer-4400000020",
    });
    await insert({
      id: "g3",
      title: "DevOps Engineer",
      status: "processing",
      jobUrl: "https://ca.linkedin.com/jobs/view/devops-4400000020",
    });

    const groups = await jobsRepo.getDuplicateGroups();
    expect(groups).toHaveLength(2);
    expect(groups[0].jobs).toHaveLength(3);
    expect(groups[1].jobs).toHaveLength(2);
  });

  it("keeps the mark_duplicated guard and the grouping scope in lockstep", async () => {
    // Two independent literals with no shared constant: if they drift, the
    // modal offers rows the server refuses. Nothing else enforces this.
    const repoSource = await import("node:fs").then((fs) =>
      fs.promises.readFile(
        new URL("./jobs.ts", import.meta.url).pathname,
        "utf8",
      ),
    );
    const routeSource = await import("node:fs").then((fs) =>
      fs.promises.readFile(
        new URL("../api/routes/jobs.ts", import.meta.url).pathname,
        "utf8",
      ),
    );
    const statuses = (source: string, name: string) =>
      source
        .slice(source.indexOf(name))
        .slice(0, 260)
        .match(/"(discovered|selected|processing|ready|backlog|stale|skipped|closed)"/g);

    const scope = statuses(repoSource, "DUPLICATE_SCOPE_STATUSES");
    const guard = statuses(routeSource, "DUPLICATE_FROM_STATUSES");
    // Both sides null — e.g. if the two were unified behind one shared
    // constant, which is the fix this test argues for — would compare equal
    // and pass while guaranteeing nothing. Assert they were actually found.
    expect(scope).toHaveLength(4);
    expect(guard).toHaveLength(4);
    expect(scope).toEqual(guard);
  });
});
